// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * BondVault — Arc Agentic Economy Hackathon (Track 4)
 *
 * 設計原則(Althemis 継承):罰=決定論域 / 評判=確率域。
 *   - slash 対象は「第三者が決定論的に再現して true/false を出せる捏造」のみ(第1層)。
 *   - 質・解釈・当たり外れ(第2/3層)は一切扱わない。それは off-chain の評判/tier 層の仕事。
 *
 * Nanopayments との関係 = 2層構造:
 *   - 決済層(高頻度・sub-cent)= Circle Gateway / x402。このコントラクトは一切触らない。
 *   - 担保層(低頻度・bond)= ここ。捏造の challenge 時のみ発火する。
 *   provider は出力に署名する(withVerifiedGateway)。よって個々の payment を
 *   on-chain 登録する必要はなく、捏造が起きた出力だけを事後 challenge する。
 *
 * slash トリガー2系統:
 *   - CLAIM_ONCHAIN(③ tx実在等)= コントラクトが自分で検証 → 即時確定。
 *   - CLAIM_OFFCHAIN(①ソース存在 / ②数値一致 = HTTP fetch)= optimistic challenge。
 *     challenger が stake → 期間内に provider が defend(検証通過の証拠)を出せねば slash。
 *     trusted oracle 不要(誰でも再現できる検証を、誰でも challenge/defend できる)。
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BondVault {
    // ───────────────────────── 型 ─────────────────────────

    enum ClaimType {
        ONCHAIN,   // ③ tx hash 実在・内容一致など。コントラクトが自己検証可能 → 即時。
        OFFCHAIN   // ①② ソース存在・引用数値一致など HTTP 検証 → optimistic challenge。
    }

    /// (a-3) state アサーションの比較演算子。fabricated = NOT(actual op expected)。
    enum Op { GTE, LTE, EQ, GT, LT, NEQ }

    enum Status { None, Pending, Defended, SlashConfirmed, ChallengeFailed }

    struct Challenge {
        address provider;       // 被告(出力を出した売り手エージェント)
        address challenger;     // 申立人(buyer or watcher、誰でも可)
        ClaimType claimType;
        bytes32 outputHash;     // provider が署名した出力の hash(否認不可の固定点)
        uint256 stake;          // challenger の供託(虚偽申立への抑止)
        uint64  openedAt;
        Status  status;
    }

    // ───────────────────────── 状態 ─────────────────────────

    IERC20 public immutable usdc;
    address public protocol;            // 運営側受取(v1)。v2 で分散化。

    uint64  public constant CHALLENGE_WINDOW = 1 hours;   // optimistic 反証期間(デモ用に短め)
    uint256 public constant CHALLENGER_STAKE = 1e6;       // 1 USDC(虚偽申立抑止)

    // slash 配分 60/20/20(Althemis 継承):被害補填 / 発見報酬 / protocol
    uint16 public constant BPS_VICTIM     = 6000;
    uint16 public constant BPS_CHALLENGER = 2000;
    uint16 public constant BPS_PROTOCOL   = 2000;

    mapping(address => uint256) public bondOf;          // provider => 供託残高
    mapping(address => uint256) public lockedOf;        // provider => challenge 中のロック額
    mapping(bytes32 => Challenge) public challenges;    // challengeId => Challenge

    // ───────────────────────── イベント ─────────────────────────

    event BondDeposited(address indexed provider, uint256 amount);
    event BondWithdrawn(address indexed provider, uint256 amount);
    event Challenged(bytes32 indexed id, address indexed provider, address indexed challenger, ClaimType claimType);
    event Defended(bytes32 indexed id, bytes32 counterHash);
    event Slashed(bytes32 indexed id, address indexed provider, uint256 amount);
    event ChallengeRejected(bytes32 indexed id);

    constructor(address _usdc, address _protocol) {
        usdc = IERC20(_usdc);
        protocol = _protocol;
    }

    // ───────────────────────── bond 供託 ─────────────────────────

    function depositBond(uint256 amount) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer failed");
        bondOf[msg.sender] += amount;
        emit BondDeposited(msg.sender, amount);
    }

    /// challenge 中ロック分は引き出せない(free = bond - locked)。
    function withdrawBond(uint256 amount) external {
        uint256 free = bondOf[msg.sender] - lockedOf[msg.sender];
        require(amount <= free, "exceeds free bond");
        bondOf[msg.sender] -= amount;
        require(usdc.transfer(msg.sender, amount), "transfer failed");
        emit BondWithdrawn(msg.sender, amount);
    }

    // ───────────────────────── challenge ─────────────────────────

    /**
     * 誰でも、provider が署名した出力を証拠に捏造を申し立てられる。
     * @param provider   出力を出した売り手
     * @param outputHash provider が署名した出力の hash
     * @param sig        provider の EIP-191 署名(否認不可の固定点)
     * @param claimType  ONCHAIN(即時) / OFFCHAIN(optimistic)
     * @param evidence   ③なら検証可能な assertion のエンコード、①②なら主張内容のエンコード
     */
    function challenge(
        address provider,
        bytes32 outputHash,
        bytes calldata sig,
        ClaimType claimType,
        bytes calldata evidence
    ) external returns (bytes32 id) {
        // 1) provider 署名検証 → この出力は確かに provider のもの(否認不可)
        require(_verifySig(provider, outputHash, sig), "bad signature");

        // 2) challenger stake を徴収(虚偽申立への抑止)
        require(usdc.transferFrom(msg.sender, address(this), CHALLENGER_STAKE), "stake failed");

        uint256 penalty = _penaltyFor(provider);
        require(bondOf[provider] - lockedOf[provider] >= penalty, "insufficient free bond");
        lockedOf[provider] += penalty;

        id = keccak256(abi.encode(provider, outputHash, msg.sender, block.timestamp));
        challenges[id] = Challenge({
            provider: provider,
            challenger: msg.sender,
            claimType: claimType,
            outputHash: outputHash,
            stake: CHALLENGER_STAKE,
            openedAt: uint64(block.timestamp),
            status: Status.Pending
        });
        emit Challenged(id, provider, msg.sender, claimType);

        // 3) ③ ONCHAIN は即時確定を試みる(コントラクトが自己検証)
        if (claimType == ClaimType.ONCHAIN) {
            bool fabricated = _verifyOnchainClaim(outputHash, evidence);
            if (fabricated) {
                _slash(id);          // 捏造確定 → 即 slash
            } else {
                _reject(id);         // 検証通過 → 虚偽申立、challenger stake 没収
            }
        }
        // ① ② OFFCHAIN は CHALLENGE_WINDOW の間 provider の defend を待つ。
    }

    /// provider が「検証は通る」反証を提示(①②の optimistic 防御)。
    /// 反証の正否は再実行で誰でも確認できる前提 → defend が虚偽なら resolve で見抜ける。
    function defend(bytes32 id, bytes calldata counterEvidence) external {
        Challenge storage c = challenges[id];
        require(c.status == Status.Pending, "not pending");
        require(msg.sender == c.provider, "not provider");
        require(block.timestamp <= c.openedAt + CHALLENGE_WINDOW, "window closed");
        // OFFCHAIN(①②)は HTTP 検証ゆえ on-chain 再実行は不可。
        // counterEvidence(再 fetch 可能な証拠への hash)を固定点として刻み、
        // off-chain watcher が再検証できる形で残す。v1 は optimistic:
        // 反証が出た時点で申立を棄却側へ。正面の UMA escalation は v2。
        require(counterEvidence.length > 0, "empty counter-evidence");
        c.status = Status.Defended;
        emit Defended(id, keccak256(counterEvidence));
    }

    /// 期間後の確定。defend が無ければ slash、あれば申立棄却。
    function resolve(bytes32 id) external {
        Challenge storage c = challenges[id];
        require(c.status == Status.Pending || c.status == Status.Defended, "not resolvable");
        require(block.timestamp > c.openedAt + CHALLENGE_WINDOW, "window open");

        if (c.status == Status.Pending) {
            _slash(id);     // 反証なし → 捏造確定
        } else {
            _reject(id);    // 反証あり → 申立棄却
        }
    }

    // ───────────────────────── 確定処理 ─────────────────────────

    function _slash(bytes32 id) internal {
        Challenge storage c = challenges[id];
        uint256 penalty = _penaltyFor(c.provider);

        // ロック解除 → bond から減算
        lockedOf[c.provider] -= penalty;
        bondOf[c.provider]   -= penalty;

        // 60/20/20 配分(被害補填 / 発見報酬 / protocol)
        uint256 toVictim     = penalty * BPS_VICTIM / 10000;
        uint256 toChallenger = penalty * BPS_CHALLENGER / 10000;
        uint256 toProtocol   = penalty - toVictim - toChallenger;

        // v1: victim == challenger 前提(buyer 自身が申し立てる)。
        // 別人なら outputHash に紐づく buyer アドレスを別途解決する(TODO)。
        require(usdc.transfer(c.challenger, toVictim + toChallenger + c.stake), "payout failed");
        require(usdc.transfer(protocol, toProtocol), "protocol payout failed");

        c.status = Status.SlashConfirmed;
        emit Slashed(id, c.provider, penalty);
    }

    function _reject(bytes32 id) internal {
        Challenge storage c = challenges[id];
        uint256 penalty = _penaltyFor(c.provider);
        lockedOf[c.provider] -= penalty;           // ロック解除のみ、bond は無傷
        // 虚偽申立 → challenger stake は没収(protocol へ)
        require(usdc.transfer(protocol, c.stake), "stake forfeit failed");
        c.status = Status.ChallengeFailed;
        emit ChallengeRejected(id);
    }

    // ───────────────────────── 内部ヘルパ ─────────────────────────

    /// penalty サイズ。Althemis は tier 連動(200/150/100%)。v1 は固定 or 出力価格連動。
    function _penaltyFor(address /*provider*/) internal pure returns (uint256) {
        return 10e6; // 暫定 10 USDC。本実装で tier / 出力価格に連動。
    }

    /// provider の EIP-191(personal_sign)署名検証。
    /// off-chain は ethers の signMessage(getBytes(outputHash)) で署名する(生32バイト)。
    /// tryRecover でバグった署名は revert せず false に倒す → challenge 側の require が弾く。
    function _verifySig(address provider, bytes32 outputHash, bytes calldata sig)
        internal pure returns (bool)
    {
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(outputHash);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethHash, sig);
        return err == ECDSA.RecoverError.NoError && recovered == provider;
    }

    /// ③ ONCHAIN claim の自己検証 = (a-3) 現在 state アサーション。
    /// outputHash は検証可能な assertion そのものの hash:
    ///   outputHash == keccak256(abi.encode(target, callData, op, expected))
    /// ゆえに challenger は provider が署名した assertion 以外を持ち込めない(改竄不能)。
    /// 検証は target への staticcall 再実行のみ → trusted oracle 不要・誰でも再現可能。
    /// 注意:これは「現在 state の痕跡」照合。供給後に引き出すと残高ゼロ=誤検知になりうる
    ///   (任意過去 tx の照合は (a-1) Merkle receipt proof で v2)。ポジションが残るべき
    ///   DeFi 実行代行詐称には正しく届くため、デモ範囲では十分。
    function _verifyOnchainClaim(bytes32 outputHash, bytes calldata evidence)
        internal view returns (bool fabricated)
    {
        // 1) evidence を provider 署名済み assertion に束縛(craft 防止)
        require(keccak256(evidence) == outputHash, "evidence mismatch");

        (address target, bytes memory callData, Op op, uint256 expected) =
            abi.decode(evidence, (address, bytes, Op, uint256));

        // 2) Arc 上で照合先を staticcall 再実行(read-only)
        (bool ok, bytes memory ret) = target.staticcall(callData);

        // 3) 呼び出し失敗 / 戻り値なし = 照合先が存在しない・壊れている → 捏造
        if (!ok || ret.length < 32) return true;

        uint256 actual = abi.decode(ret, (uint256));

        // 4) assertion が成立しなければ捏造。例:supply 主張 vs aToken 残高 GTE。
        return !_eval(op, actual, expected);
    }

    function _eval(Op op, uint256 a, uint256 b) internal pure returns (bool) {
        if (op == Op.GTE) return a >= b;
        if (op == Op.LTE) return a <= b;
        if (op == Op.EQ)  return a == b;
        if (op == Op.GT)  return a >  b;
        if (op == Op.LT)  return a <  b;
        return a != b; // NEQ
    }
}
