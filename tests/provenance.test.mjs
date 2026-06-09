import assert from "node:assert/strict";
import test from "node:test";
import { extractProofObligations } from "../dist/obligations/extract.js";
import { extractCairoStarknetProvenance } from "../dist/provenance/cairo.js";
import { extractGoWormholeProvenance } from "../dist/provenance/go.js";
import { extractHalo2Provenance, renderProvenanceGraph } from "../dist/provenance/halo2.js";
import { extractRustSolanaProvenance, extractRustZkProvenance } from "../dist/provenance/rust.js";
import { extractSolidityProvenance } from "../dist/provenance/solidity.js";

test("Halo2 provenance extracts advice assignments, copies, and assignment-flow obligations", () => {
  const graph = extractHalo2Provenance([
    {
      path: "chip/mul/incomplete.rs",
      kind: "source",
      content: `
fn assign_incomplete_addition_input(region: &mut Region, row: usize, offset: usize, x_p: Value, y_p: Value) {
    // point scalar multiplication witness advice
    region.assign_advice(|| "x_p", self.double_and_add.x_p, row + offset, || x_p)?;
    region.assign_advice(|| "y_p", self.y_p, row + offset, || y_p)?;
    base_x.copy_advice(|| "base_x", region, self.double_and_add.x_p, row)?;
    meta.create_gate("mul gate", |meta| {
        let q_mul = meta.query_selector(config.q_mul);
        let x = meta.query_advice(config.x, Rotation::cur());
        vec![q_mul * x]
    });
}
`,
    },
  ]);

  assert.equal(graph.domain, "halo2");
  assert.equal(graph.summary.byKind.advice_assignment, 2);
  assert.equal(graph.summary.byKind.advice_copy, 1);
  assert.equal(graph.summary.byKind.gate_creation, 1);
  assert.ok(graph.summary.assignmentFlowObligations >= 2);
  assert.ok(graph.obligations.every((obligation) => obligation.kind === "provenance"));

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /assign_incomplete_addition_input/);
  assert.match(rendered, /source=x_p/);
  assert.match(rendered, /assignment-flow obligations/i);
});

test("Solidity provenance extracts EVM audit-routing facts and obligations", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/Vault.sol",
      kind: "source",
      content: `
contract Vault {
    AggregatorV3Interface public priceFeed;
    mapping(address => uint256) public balanceOf;

    function initialize(address feed) external initializer {
        priceFeed = AggregatorV3Interface(feed);
    }

    function upgradeTo(address impl, bytes calldata data) external onlyOwner {
        impl.delegatecall(data);
    }

    function deposit(uint256 assets) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        balanceOf[msg.sender] += assets;
    }

    function withdraw(uint256 shares, bytes calldata sig) external nonReentrant {
        bytes32 digest = _hashTypedDataV4(keccak256(sig));
        address signer = ECDSA.recover(digest, sig);
        (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        require(answer > 0 && updatedAt + 1 hours >= block.timestamp, "STALE");
        unchecked { balanceOf[msg.sender] -= shares; }
        (bool ok,) = msg.sender.call{value: shares}("");
        require(ok, "ETH_SEND");
    }
}
`,
    },
  ]);

  assert.equal(graph.domain, "solidity");
  assert.equal(graph.summary.byKind.evm_external_function, 4);
  assert.equal(graph.summary.byKind.evm_delegatecall, 1);
  assert.equal(graph.summary.byKind.evm_token_transfer, 1);
  assert.ok((graph.summary.byKind.evm_state_write ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_signature_check ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_oracle_read ?? 0) >= 1);
  assert.equal(graph.summary.byKind.evm_external_call, 1);
  assert.equal(graph.summary.byKind.evm_unchecked_arithmetic, 1);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-external-call-state-finalization"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-upgrade-initializer-storage"));
  assert.ok(graph.obligations.every((obligation) => obligation.kind === "provenance"));

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /Domain: solidity/);
  assert.match(rendered, /Routing obligations/);
  assert.match(rendered, /kind=evm_delegatecall/);
  assert.match(rendered, /latestRoundData/);
});

test("Solidity provenance extracts selector allowlist forwarding obligations", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/GraphTokenLockWallet.sol",
      kind: "source",
      content: `
interface IManaged {
    function getAuthFunctionCallTarget(bytes4 selector) external view returns (address);
}

library Address {
    function functionCall(address target, bytes memory data) internal returns (bytes memory) {}
}

contract GraphTokenLockWallet {
    address public manager;
    address public beneficiary;

    fallback() external payable {
        require(msg.sender == beneficiary, "Unauthorized caller");
        address target = IManaged(manager).getAuthFunctionCallTarget(msg.sig);
        require(target != address(0), "Unauthorized function");
        Address.functionCall(target, msg.data);
    }
}
`,
    },
    {
      path: "contracts/GraphTokenLockManager.sol",
      kind: "source",
      content: `
contract GraphTokenLockManager {
    mapping(bytes4 => address) public authFnCalls;

    function setAuthFunctionCall(string calldata signature, address target) external onlyOwner {
        bytes4 sigHash = _toFunctionSigHash(signature);
        authFnCalls[sigHash] = target;
    }

    function getAuthFunctionCallTarget(bytes4 selector) external view returns (address) {
        return authFnCalls[selector];
    }

    function _toFunctionSigHash(string calldata signature) internal pure returns (bytes4) {
        return bytes4(keccak256(bytes(signature)));
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_selector_forwarding ?? 0) >= 5);
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-selector-forwarding-allowlist-collision",
    ),
  );

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /kind=evm_selector_forwarding/);
  assert.match(rendered, /getAuthFunctionCallTarget/);
  assert.match(rendered, /authFnCalls/);
});

test("Solidity provenance extracts recurring agreement lifecycle obligations", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/payments/collectors/RecurringCollector.sol",
      kind: "source",
      content: `
contract RecurringCollector {
    struct StoredOffer {
        bytes32 offerHash;
        bytes data;
    }

    struct AgreementData {
        address payer;
        address dataService;
        address serviceProvider;
        bytes32 activeTermsHash;
        uint32 updateNonce;
        uint64 lastCollectionAt;
        uint32 minSecondsPerCollection;
        uint32 maxSecondsPerCollection;
        uint256 maxInitialTokens;
        uint256 maxOngoingTokensPerSecond;
    }

    mapping(bytes16 => AgreementData) agreements;
    mapping(bytes16 => StoredOffer) rcaOffers;
    mapping(bytes16 => StoredOffer) rcauOffers;
    mapping(address => mapping(bytes32 => bytes16)) cancelledOffers;

    function accept(RecurringCollectionAgreement calldata rca, bytes calldata signature) external {
        bytes16 agreementId = _generateAgreementId(rca.payer, rca.dataService, rca.serviceProvider, rca.deadline, rca.nonce);
        bytes32 rcaHash = _hashRCA(rca);
        _requireAuthorization(rca.payer, rcaHash, signature, agreementId, OFFER_TYPE_NEW);
        rcaOffers[agreementId] = StoredOffer({ offerHash: rcaHash, data: abi.encode(rca) });
        agreements[agreementId].activeTermsHash = rcaHash;
    }

    function update(RecurringCollectionAgreementUpdate calldata rcau, bytes calldata signature) external {
        AgreementData storage agreement = agreements[rcau.agreementId];
        bytes32 rcauHash = _hashRCAU(rcau);
        _requireAuthorization(agreement.payer, rcauHash, signature, rcau.agreementId, OFFER_TYPE_UPDATE);
        require(rcau.nonce == agreement.updateNonce + 1, "bad nonce");
        rcauOffers[rcau.agreementId] = StoredOffer({ offerHash: rcauHash, data: abi.encode(rcau) });
        agreement.activeTermsHash = rcauHash;
        agreement.updateNonce = rcau.nonce;
    }

    function cancel(bytes16 agreementId, bytes32 termsHash, uint16 options) external {
        cancelledOffers[msg.sender][termsHash] = agreementId;
        delete rcauOffers[agreementId];
    }

    function collect(bytes16 agreementId, uint256 requestedTokens, uint256 maxSlippage) external {
        AgreementData storage agreement = agreements[agreementId];
        uint256 collectionSeconds = _collectionSeconds(agreement.lastCollectionAt, agreement.maxSecondsPerCollection);
        uint256 maxTokens = getMaxNextClaim(agreementId);
        uint256 tokensToCollect = requestedTokens > maxTokens ? maxTokens : requestedTokens;
        require(requestedTokens - tokensToCollect <= maxSlippage, "slippage");
        agreement.lastCollectionAt = uint64(block.timestamp);
        IAgreementOwner(agreement.payer).beforeCollection(agreementId, tokensToCollect);
        paymentsEscrow.collect(agreement.payer, agreement.serviceProvider, tokensToCollect, agreement.dataService);
        IAgreementOwner(agreement.payer).afterCollection(agreementId, tokensToCollect);
    }

    function getMaxNextClaim(bytes16 agreementId) public view returns (uint256) {
        AgreementData storage agreement = agreements[agreementId];
        return agreement.maxInitialTokens + agreement.maxOngoingTokensPerSecond * agreement.maxSecondsPerCollection;
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_recurring_agreement ?? 0) >= 20);
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-recurring-agreement-authorization-accounting",
    ),
  );

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /kind=evm_recurring_agreement/);
  assert.match(rendered, /cancelledOffers/);
  assert.match(rendered, /getMaxNextClaim/);
});

test("Solidity provenance extracts payment distribution route obligations", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/payments/GraphPayments.sol",
      kind: "source",
      content: `
contract GraphPayments {
    uint256 public immutable PROTOCOL_PAYMENT_CUT;

    event GraphPaymentCollected(
        PaymentTypes paymentType,
        address payer,
        address receiver,
        address dataService,
        uint256 tokens,
        uint256 tokensProtocol,
        uint256 tokensDataService,
        uint256 tokensDelegationPool,
        uint256 tokensRemaining,
        address receiverDestination
    );

    function collect(
        PaymentTypes paymentType,
        address receiver,
        uint256 tokens,
        address dataService,
        uint256 dataServiceCut,
        address receiverDestination
    ) external {
        token.pullTokens(msg.sender, tokens);
        uint256 tokensRemaining = tokens;
        uint256 tokensProtocol = tokensRemaining.mulPPMRoundUp(PROTOCOL_PAYMENT_CUT);
        tokensRemaining = tokensRemaining - tokensProtocol;
        uint256 tokensDataService = tokensRemaining.mulPPMRoundUp(dataServiceCut);
        tokensRemaining = tokensRemaining - tokensDataService;
        uint256 tokensDelegationPool = tokensRemaining.mulPPMRoundUp(staking.getDelegationFeeCut(receiver, dataService, paymentType));
        staking.addToDelegationPool(receiver, dataService, tokensDelegationPool);
        if (receiverDestination == address(0)) staking.stakeTo(receiver, tokensRemaining);
        else token.pushTokens(receiverDestination, tokensRemaining);
        emit GraphPaymentCollected(paymentType, msg.sender, receiver, dataService, tokens, tokensProtocol, tokensDataService, tokensDelegationPool, tokensRemaining, receiverDestination);
    }
}
`,
    },
    {
      path: "contracts/payments/PaymentsEscrow.sol",
      kind: "source",
      content: `
contract PaymentsEscrow {
    event EscrowCollected(PaymentTypes paymentType, address payer, address collector, address receiver, uint256 tokens, address receiverDestination);

    function collect(
        PaymentTypes paymentType,
        address payer,
        address receiver,
        uint256 tokens,
        address dataService,
        uint256 dataServiceCut,
        address receiverDestination
    ) external {
        EscrowAccount storage account = escrowAccounts[payer][msg.sender][receiver];
        account.balance -= tokens;
        uint256 escrowBalanceBefore = token.balanceOf(address(this));
        graphPayments.collect(paymentType, receiver, tokens, dataService, dataServiceCut, receiverDestination);
        uint256 escrowBalanceAfter = token.balanceOf(address(this));
        require(escrowBalanceBefore == tokens + escrowBalanceAfter, PaymentsEscrowInconsistentCollection(escrowBalanceBefore, escrowBalanceAfter, tokens));
        emit EscrowCollected(paymentType, payer, msg.sender, receiver, tokens, receiverDestination);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_payment_distribution ?? 0) >= 12);
  assert.ok(
    graph.obligations.some((obligation) => obligation.id === "solidity-payment-distribution-route-binding"),
  );

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /kind=evm_payment_distribution/);
  assert.match(rendered, /receiverDestination/);
  assert.match(rendered, /tokensDelegationPool/);
});

test("Solidity provenance extracts Settler action and Permit2 routing facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "src/SettlerMetaTxn.sol",
      kind: "source",
      content: `
library CalldataDecoder {
    function decodeCall(bytes[] calldata actions, uint256 i) internal pure returns (uint256 selector, bytes calldata args) {
        assembly ("memory-safe") {
            args.offset := add(actions.offset, calldataload(i))
            args.length := calldataload(args.offset)
        }
    }
}

contract SettlerMetaTxn {
    function _hashArrayOfBytes(bytes[] calldata actions) internal pure returns (bytes32 result) {
        result = keccak256(abi.encode(actions));
    }

    function _hashActionsAndSlippage(bytes[] calldata actions, AllowedSlippage memory slippage) internal pure returns (bytes32) {
        return keccak256(abi.encode(SLIPPAGE_AND_ACTIONS_TYPEHASH, slippage.recipient, slippage.buyToken, slippage.minAmountOut, _hashArrayOfBytes(actions)));
    }

    function executeMetaTxn(AllowedSlippage memory slippage, bytes[] calldata actions, address msgSender, bytes calldata sig) public metaTx(msgSender, _hashActionsAndSlippage(actions, slippage)) returns (bool) {
        require(actions.length != 0);
        (uint256 action, bytes calldata data) = actions.decodeCall(actions.offset);
        if (!_dispatchVIP(action, data, sig)) revertActionInvalid(0, action, data);
        _checkSlippageAndTransfer(slippage, false);
        return true;
    }

    function _dispatchVIP(uint256 action, bytes calldata data, bytes calldata sig) internal returns (bool) {
        if (action == uint32(ISettlerActions.METATXN_TRANSFER_FROM.selector)) {
            (address recipient, ISignatureTransfer.PermitTransferFrom memory permit) = abi.decode(data, (address, ISignatureTransfer.PermitTransferFrom));
            _transferFrom(permit, _permitToTransferDetails(permit, recipient), sig);
        }
        return true;
    }
}
`,
    },
    {
      path: "src/core/Basic.sol",
      kind: "source",
      content: `
contract Basic {
    function basicSellToPool(IERC20 sellToken, uint256 bps, address pool, uint256 offset, bytes memory data) internal {
        if (_isRestrictedTarget(pool)) revertConfusedDeputy();
        (bool success,) = payable(pool).call(data);
        if (pool.code.length == 0) revert InvalidTarget();
    }
}
`,
    },
    {
      path: "src/core/Permit2Payment.sol",
      kind: "source",
      content: `
library TransientStorage {
    bytes32 private constant _PAYER_SLOT = bytes32(uint256(1));
    bytes32 private constant _OPERATOR_SLOT = bytes32(uint256(2));
    bytes32 private constant _WITNESS_SLOT = bytes32(uint256(3));

    function setPayer(address payer) internal {
        assembly { tstore(_PAYER_SLOT, payer) }
    }

    function clearPayer(address payer) internal {
        assembly { tstore(_PAYER_SLOT, 0) }
    }
}

contract Permit2Payment {
    function _transferFrom(ISignatureTransfer.PermitTransferFrom memory permit, ISignatureTransfer.SignatureTransferDetails memory details, bytes calldata sig) internal {
        PERMIT2.permitWitnessTransferFrom(permit, details, _msgSender(), _witness(), _witnessTypeSuffix(), sig);
    }

    function _operator() internal view returns (address operator) {}
    function _msgSender() internal view returns (address sender) {}
}
`,
    },
    {
      path: "src/chains/Mainnet/BridgeSettler.sol",
      kind: "source",
      content: `
contract MainnetBridgeSettler {
    function _dispatch(uint256 action, bytes calldata data) internal returns (bool) {
        if (action == uint32(IBridgeSettlerActions.BRIDGE_TO_NUCLEUS_TELLER.selector)) {
            bridgeToNucleusTeller(data);
        } else if (action == uint32(IBridgeSettlerActions.BRIDGE_NATIVE_TO_RELAY.selector)) {
            bridgeNativeToRelay(msg.sender, bytes32(0));
        }
        return true;
    }
}
`,
    },
    {
      path: "src/core/NucleusTeller.sol",
      kind: "source",
      content: `
contract NucleusTeller {
    function _callTeller(bytes memory data) private {
        assembly {
            if iszero(call(gas(), NUCLEUS_TELLER, selfbalance(), add(0x1c, data), add(0x04, mload(data)), 0x00, 0x00)) { revert(0x00, 0x00) }
        }
    }
}
`,
    },
    {
      path: "src/core/Relay.sol",
      kind: "source",
      content: `
contract Relay {
    function bridgeNativeToRelay(address to, bytes32 requestId) internal {
        assembly {
            if iszero(call(gas(), to, selfbalance(), 0x00, 0x20, 0x00, 0x00)) { revert(0x00, 0x00) }
        }
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_permit2_witness_binding ?? 0) >= 4);
  assert.ok((graph.summary.byKind.evm_settler_action_dispatch ?? 0) >= 5);
  assert.ok((graph.summary.byKind.evm_settler_slippage_binding ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_settler_calldata_decoder ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_settler_transient_context ?? 0) >= 3);
  assert.ok((graph.summary.byKind.evm_settler_restricted_target ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_settler_full_balance_bridge_sink ?? 0) >= 4);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-permit2-witness-action-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-settler-action-dispatch-integrity"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-settler-slippage-payout-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-settler-calldata-aliasing-boundary"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-settler-transient-context-isolation"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-settler-restricted-target-confused-deputy"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-settler-full-balance-bridge-sweep"));
});

test("Solidity provenance extracts bridge and OFT routing facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/BridgePool.sol",
      kind: "source",
      content: `
contract BridgePool {
    mapping(uint16 => address) public stargateImpls;
    mapping(uint32 => Path) public paths;
    uint64 public treasuryFee;
    uint128 public nativeDropAmount;

    function sendToken(uint32 dstEid, bytes32 receiver, uint256 amountLD, uint256 minAmountLD) external {
        uint64 amountSD = _ld2sd(amountLD);
        paths[dstEid].decreaseCredit(amountSD);
        bytes memory message = TaxiCodec.encodeTaxi(msg.sender, 1, receiver, amountSD, "");
        _lzSend(dstEid, message, "", MessagingFee(msg.value, 0), msg.sender);
    }

    function prepareSend(IOFT stargate, uint32 dstEid, bytes32 receiver, uint256 amountLD, uint256 minAmountOut) external view returns (SendParam memory sendParam) {
        sendParam = SendParam({
            dstEid: dstEid,
            to: receiver,
            amountLD: amountLD,
            minAmountLD: minAmountOut,
            extraOptions: bytes(""),
            composeMsg: bytes(""),
            oftCmd: ""
        });
        (, , OFTReceipt memory receipt) = stargate.quoteOFT(sendParam);
        sendParam.minAmountLD = receipt.amountReceivedLD;
    }

    function _lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message) internal {
        (uint16 assetId, bytes32 receiver, uint64 amountSD,) = TaxiCodec.decodeTaxi(message);
        IERC20Minter(stargateImpls[assetId]).mint(address(uint160(uint256(receiver))), _sd2ld(amountSD));
        emit Received(origin.srcEid, guid, nativeDropAmount);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_bridge_message ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_bridge_asset_mapping ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_bridge_credit_accounting ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_bridge_native_drop ?? 0) >= 1);
  assert.ok((graph.summary.byKind.evm_oft_supply_change ?? 0) >= 2);
  assert.ok(graph.facts.some((fact) => fact.kind === "evm_bridge_credit_accounting" && /quoteOFT/.test(fact.sourceExpression)));
  assert.ok(graph.facts.some((fact) => fact.kind === "evm_bridge_credit_accounting" && /amountReceivedLD/.test(fact.sourceExpression)));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-bridge-message-domain-and-payload-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-bridge-credit-and-liquidity-conservation"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-oft-mint-burn-lock-unlock-conservation"));
});

test("Solidity provenance extracts Wormhole VAA and governance routing facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/bridge/Bridge.sol",
      kind: "source",
      content: `
contract Bridge {
    IWormhole public wormhole;
    mapping(uint16 => bytes32) public bridgeContracts;
    mapping(bytes32 => bool) public completedTransfers;

    function completeTransfer(bytes memory encodedVm) external {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(encodedVm);
        require(valid, reason);
        require(bridgeContracts[vm.emitterChainId] == vm.emitterAddress, "bad emitter");
        require(!completedTransfers[vm.hash], "transfer already completed");
        completedTransfers[vm.hash] = true;
        emit TransferRedeemed(vm.emitterChainId, vm.emitterAddress, vm.sequence);
    }

    function submitGovernance(bytes memory encodedVM) external {
        (IWormhole.VM memory vm, bool valid,) = wormhole.parseAndVerifyVM(encodedVM);
        require(valid, "invalid governance vaa");
        require(vm.guardianSetIndex == wormhole.getCurrentGuardianSetIndex(), "stale guardian set");
        require(vm.emitterChainId == wormhole.governanceChainId(), "bad governance chain");
        require(vm.emitterAddress == wormhole.governanceContract(), "bad governance emitter");
        require(!governanceActionIsConsumed(vm.hash), "consumed");
        consumeGovernanceAction(vm.hash);
    }

    function verifyRaw(bytes32 hash, IWormhole.Signature[] memory signatures, IWormhole.GuardianSet memory guardianSet) external pure {
        (bool ok,) = IWormhole(address(0)).verifySignatures(hash, signatures, guardianSet);
        require(ok, "bad guardian quorum");
    }

    function publish(uint32 nonce, bytes memory payload, uint8 consistencyLevel) external payable {
        wormhole.publishMessage{ value: msg.value }(nonce, payload, consistencyLevel);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_wormhole_vaa ?? 0) >= 10);
  assert.ok((graph.summary.byKind.evm_bridge_message ?? 0) >= 1);
  assert.ok(graph.facts.some((fact) => fact.kind === "evm_wormhole_vaa" && /parseAndVerifyVM/.test(fact.sourceExpression)));
  assert.ok(graph.facts.some((fact) => fact.kind === "evm_wormhole_vaa" && /guardianSetIndex/.test(fact.sourceExpression)));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-wormhole-vaa-guardian-emitter-binding"));
  assert.ok(graph.obligations.some((obligation) => /guardian-set index/.test(obligation.property)));
});

test("Solidity provenance extracts Hyperlane mailbox and ISM routing facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/HyperlaneRouter.sol",
      kind: "source",
      content: `
contract HyperlaneRouter is IMessageRecipient {
    IMailbox public mailbox;
    IInterchainSecurityModule public defaultIsm;
    mapping(uint32 => bytes32) public remoteRouters;
    bytes32 public latestDispatchedId;

    function dispatch(uint32 destinationDomain, bytes32 recipient, bytes calldata messageBody) external payable {
        bytes32 messageId = mailbox.dispatch{ value: msg.value }(destinationDomain, recipient, messageBody);
        latestDispatchedId = messageId;
    }

    function process(bytes calldata metadata, bytes calldata message) external {
        require(msg.sender == address(mailbox), "bad mailbox");
        require(defaultIsm.verify(metadata, message), "bad ism");
        mailbox.process(metadata, message);
    }

    function enrollRemoteRouter(uint32 originDomain, bytes32 router) external onlyOwner {
        remoteRouters[originDomain] = router;
    }

    function handle(uint32 origin, bytes32 sender, bytes calldata body) external {
        require(msg.sender == address(mailbox), "only mailbox");
        require(remoteRouters[origin] == sender, "bad router");
        _mint(msg.sender, body.length);
    }

    function quoteDispatch(uint32 destinationDomain, bytes32 recipient, bytes calldata messageBody) external view returns (uint256) {
        return mailbox.quoteDispatch(destinationDomain, recipient, messageBody);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_bridge_message ?? 0) >= 5);
  assert.ok((graph.summary.byKind.evm_bridge_asset_mapping ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_bridge_credit_accounting ?? 0) >= 1);
  assert.ok(graph.facts.some((fact) => fact.kind === "evm_bridge_message" && /mailbox\.process/.test(fact.sourceExpression)));
  assert.ok(graph.facts.some((fact) => fact.kind === "evm_bridge_asset_mapping" && /remoteRouters/.test(fact.sourceExpression)));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-bridge-message-domain-and-payload-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.property.includes("mailbox")));
});

test("Solidity provenance extracts stablecoin mint redeem and staking facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/EthenaCore.sol",
      kind: "source",
      content: `
contract EthenaCore is ERC4626 {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    mapping(address => uint256) public nonces;
    mapping(address => Cooldown) public cooldowns;
    mapping(address => bool) public fullRestrictedStaker;

    function mint(Order calldata order, Route calldata route, bytes calldata signature) external {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(order)));
        address signer = ECDSA.recover(digest, signature);
        require(hasRole(MINTER_ROLE, signer), "bad signer");
        nonces[order.beneficiary] += 1;
        IERC20(order.collateralAsset).safeTransferFrom(order.benefactor, route.custodian, order.collateralAmount);
        USDe.mint(order.beneficiary, order.usdeAmount);
    }

    function cooldownAssets(uint256 assets, address owner) external returns (uint256 shares) {
        if (fullRestrictedStaker[owner]) revert Restricted();
        shares = previewWithdraw(assets);
        _withdraw(msg.sender, address(silo), owner, assets, shares);
        cooldowns[owner] = Cooldown(block.timestamp, assets);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_mint_redeem_order ?? 0) >= 4);
  assert.ok((graph.summary.byKind.evm_erc4626_cooldown ?? 0) >= 3);
  assert.ok((graph.summary.byKind.evm_restriction_role ?? 0) >= 2);
  assert.ok(
    graph.obligations.some((obligation) => obligation.id === "solidity-mint-redeem-order-collateral-binding"),
  );
  assert.ok(
    graph.obligations.some((obligation) => obligation.id === "solidity-erc4626-cooldown-share-asset-conservation"),
  );
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-role-restriction-transfer-and-privilege-boundaries",
    ),
  );
});

test("Solidity provenance extracts deployed stablecoin V2 authorization and limit facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/EthenaMintingV2.sol",
      kind: "source",
      content: `
contract EthenaMintingV2 {
    mapping(address => bool) private _whitelistedBenefactors;
    mapping(address => mapping(address => bool)) private _approvedBeneficiariesPerBenefactor;
    mapping(uint256 => mapping(address => BlockTotals)) public totalPerBlockPerAsset;
    uint128 public stablesDeltaLimit;
    bytes4 private constant EIP1271_MAGICVALUE = bytes4(keccak256("isValidSignature(bytes32,bytes)"));

    function verifyOrder(Order calldata order, Signature calldata signature) public view returns (bytes32 digest) {
        if (signature.signature_type == SignatureType.EIP1271) {
            if (IERC1271(order.benefactor).isValidSignature(digest, signature.signature_bytes) != EIP1271_MAGICVALUE) {
                revert InvalidEIP1271Signature();
            }
        }
        if (!_whitelistedBenefactors[order.benefactor]) revert BenefactorNotWhitelisted();
        if (order.benefactor != order.beneficiary && !_approvedBeneficiariesPerBenefactor[order.benefactor][order.beneficiary]) {
            revert BeneficiaryNotApproved();
        }
        if (!verifyStablesLimit(order.collateral_amount, order.usde_amount, order.collateral_asset, order.order_type)) {
            revert InvalidStablePrice();
        }
    }

    function verifyStablesLimit(uint128 collateralAmount, uint128 usdeAmount, address collateralAsset, OrderType orderType) public view returns (bool) {
        uint128 collateralDecimals = IERC20Metadata(collateralAsset).decimals();
        uint128 differenceInBps = ((collateralAmount - usdeAmount) * 10000) / usdeAmount;
        return differenceInBps <= stablesDeltaLimit || orderType == OrderType.REDEEM;
    }

    function redeem(Order calldata order) external belowGlobalMaxRedeemPerBlock(order.usde_amount) {
        totalPerBlockPerAsset[block.number][order.collateral_asset].redeemedPerBlock += order.usde_amount;
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_eip1271_signature ?? 0) >= 2);
  assert.ok((graph.summary.byKind.evm_beneficiary_allowlist ?? 0) >= 3);
  assert.ok((graph.summary.byKind.evm_stable_price_limit ?? 0) >= 3);
  assert.ok((graph.summary.byKind.evm_block_limit ?? 0) >= 2);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-eip1271-contract-signature-boundary"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-benefactor-beneficiary-allowlist-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-stable-price-decimal-limit"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solidity-per-asset-global-block-limit"));
});

test("Solidity provenance extracts async request and solver settlement facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "v3/src/core/Provisioner.sol",
      kind: "source",
      content: `
contract Provisioner {
    mapping(bytes32 => bool) public asyncDepositHashes;
    mapping(bytes32 => bool) public asyncRedeemHashes;
    mapping(bytes32 => bool) public syncDepositHashes;
    mapping(address => uint256) public userUnitsRefundableUntil;
    uint256 public depositCap;

    function requestDeposit(address token, uint256 tokensAmount, uint256 unitsAmount, uint256 solverTip, uint256 deadline, uint256 maxPriceAge) external {
        bytes32 requestHash = _getRequestHash(RequestType.Deposit, token, msg.sender, tokensAmount, unitsAmount, solverTip, deadline, maxPriceAge);
        asyncDepositHashes[requestHash] = true;
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensAmount);
    }

    function solveRequestsDirect(Request[] calldata requests, TokenDetails calldata tokenDetails, address solver) external {
        uint256 units = convertTokenToUnits(requests[0].token, requests[0].tokens, tokenDetails.unitPrice);
        asyncDepositHashes[_getRequestHash(requests[0])] = false;
        vault.safeTransferFrom(solver, requests[0].user, units);
        IERC20(requests[0].token).safeTransfer(solver, requests[0].tokens - requests[0].solverTip);
    }

    function refundRequest(Request calldata request) external {
        if (request.deadline < block.timestamp) {
            asyncRedeemHashes[_getRequestHash(request)] = false;
            vault.transfer(request.user, request.units);
        }
    }

    function areUserUnitsLocked(address user) external view returns (bool) {
        return userUnitsRefundableUntil[user] >= block.timestamp;
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_async_request_settlement ?? 0) >= 10);
  assert.ok(
    graph.facts.some(
      (fact) => fact.kind === "evm_async_request_settlement" && /solveRequestsDirect/.test(fact.sourceExpression),
    ),
  );
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-async-request-solver-settlement-conservation",
    ),
  );
});

test("Solidity provenance extracts governance payload execution facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "src/StarGuard.sol",
      kind: "source",
      content: `
contract StarGuard {
    struct SpellData { address addr; bytes32 tag; uint256 deadline; }
    mapping(address => uint256) public wards;
    SpellData public spellData;
    SubProxyLike public immutable subProxy;
    uint256 public maxDelay;

    function plot(address addr_, bytes32 tag_) external auth {
        spellData.addr = addr_;
        spellData.tag = tag_;
        spellData.deadline = block.timestamp + maxDelay;
    }

    function exec() external returns (address addr) {
        SpellData memory spellDataCopy = spellData;
        require(spellDataCopy.tag == spellDataCopy.addr.codehash, "wrong-codehash");
        require(block.timestamp <= spellDataCopy.deadline, "expired-spell");
        require(StarSpellLike(spellDataCopy.addr).isExecutable(), "not-yet-executable");
        delete spellData;
        subProxy.exec(spellDataCopy.addr, abi.encodePacked(StarSpellLike.execute.selector));
        require(subProxy.wards(address(this)) == 1, "subProxy-owner-change");
        return spellDataCopy.addr;
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_governance_payload ?? 0) >= 6);
  assert.ok(
    graph.obligations.some((obligation) => obligation.id === "solidity-governance-payload-execution-boundary"),
  );
});

test("Solidity provenance extracts DAO governance voting facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/gov/GovPool.sol",
      kind: "source",
      content: `
contract GovPool {
    mapping(uint256 => Proposal) public proposals;
    GovUserKeeper public userKeeper;
    GovValidators public validators;

    function createProposal(address executor, bytes[] calldata actions) external returns (uint256 proposalId) {
        require(userKeeper.canCreate(msg.sender), "not enough power");
        proposals[proposalId].executor = executor;
        proposals[proposalId].proposalState = ProposalState.Voting;
    }

    function vote(uint256 proposalId, VoteType voteType, uint256 rawPower, bool useMicropool) external {
        uint256 votingPower = userKeeper.votingPower(msg.sender, proposalId, rawPower, useMicropool);
        if (voteType == VoteType.For) {
            proposals[proposalId].votesFor += votingPower;
        } else {
            proposals[proposalId].votesAgainst += votingPower;
        }
        require(_quorumReached(proposalId), "quorum");
    }

    function moveProposalToValidators(uint256 proposalId) external {
        validators.createExternalProposal(proposalId, proposals[proposalId].executor);
    }

    function executeProposal(uint256 proposalId) external {
        require(proposals[proposalId].proposalState == ProposalState.SucceededFor, "bad state");
        _execute(proposals[proposalId].executor, proposalId);
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_dao_governance ?? 0) >= 10);
  assert.ok(
    graph.facts.some((fact) => fact.kind === "evm_dao_governance" && /executeProposal/.test(fact.sourceExpression)),
  );
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-dao-vote-result-and-execution-integrity",
    ),
  );
});

test("Solidity provenance extracts name registry and resolution facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/registry/PermissionedRegistry.sol",
      kind: "source",
      content: `
contract PermissionedRegistry {
    ENSRegistry public registry;
    INameWrapper public nameWrapper;
    mapping(bytes32 => address) public resolver;
    mapping(bytes32 => uint64) public expiry;
    mapping(bytes32 => uint32) public fuses;

    function setSubnodeRecord(
        bytes32 node,
        bytes32 labelhash,
        address owner,
        address newResolver,
        uint64 newExpiry
    ) external onlyRole(RegistryRolesLib.SUBREGISTRAR_ROLE) {
        bytes32 subnode = keccak256(abi.encodePacked(node, labelhash));
        registry.setSubnodeOwner(node, labelhash, owner);
        registry.setResolver(subnode, newResolver);
        resolver[subnode] = newResolver;
        expiry[subnode] = newExpiry;
    }

    function setFuses(bytes32 node, uint32 newFuses) external {
        nameWrapper.setFuses(node, newFuses | CANNOT_UNWRAP | PARENT_CANNOT_CONTROL);
        fuses[node] = newFuses;
    }
}
`,
    },
    {
      path: "contracts/registrar/ETHRegistrar.sol",
      kind: "source",
      content: `
contract ETHRegistrar {
    BaseRegistrar public baseRegistrar;
    PublicResolver public publicResolver;

    function register(
        string calldata label,
        address registrant,
        bytes32 commitment,
        uint256 duration,
        bytes32 secret
    ) external payable {
        bytes32 labelhash = keccak256(bytes(label));
        uint256 price = rentPrice(label, duration);
        baseRegistrar.register(uint256(labelhash), registrant, duration);
        publicResolver.setAddr(namehash(label), registrant);
        publicResolver.setText(namehash(label), "url", label);
    }

    function renew(string calldata label, uint256 duration) external payable {
        baseRegistrar.renew(uint256(keccak256(bytes(label))), duration);
    }
}
`,
    },
    {
      path: "contracts/migration/LockedMigrationController.sol",
      kind: "source",
      content: `
contract LockedMigrationController {
    WrapperRegistry public wrapperRegistry;
    ReverseRegistrar public reverseRegistrar;

    function migrate(bytes32 node, address owner, address resolverAddress) external {
        wrapperRegistry.wrap(node, owner);
        wrapperRegistry.setResolver(node, resolverAddress);
        reverseRegistrar.setNameForAddr(owner, owner, resolverAddress, "alice.eth");
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_name_registry_resolution ?? 0) >= 14);
  assert.ok(
    graph.facts.some(
      (fact) => fact.kind === "evm_name_registry_resolution" && /setSubnodeRecord/.test(fact.sourceExpression),
    ),
  );
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-name-registry-resolution-integrity",
    ),
  );
});

test("Solidity provenance extracts validator cluster accounting facts", () => {
  const graph = extractSolidityProvenance([
    {
      path: "contracts/modules/SSVClusters.sol",
      kind: "source",
      content: `
contract SSVClusters {
    mapping(bytes32 => ClusterEBSnapshot) public clusterEB;
    mapping(uint64 => uint64) public operatorEthVUnits;
    bytes32 public latestCommittedBlock;
    uint64 public minimumBlocksBeforeLiquidation;
    uint64 public minimumLiquidationCollateral;

    function updateClusterBalance(
        uint64 blockNum,
        address clusterOwner,
        uint64[] calldata operatorIds,
        Cluster memory cluster,
        uint32 effectiveBalance,
        bytes32[] calldata merkleProof
    ) external {
        bytes32 clusterId = keccak256(abi.encodePacked(clusterOwner, operatorIds));
        MerkleProof.verify(merkleProof, ebRoots[blockNum], bytes32(effectiveBalance));
        uint64 newVUnits = ClusterLib.ebToVUnits(effectiveBalance);
        uint64 burnRate = OperatorLib.updateClusterOperators(operatorIds, false, 0, s, sp);
        sp.updateDAOEthVUnits(clusterEB[clusterId].vUnits, newVUnits);
        clusterEB[clusterId].vUnits = newVUnits;
        if (cluster.isLiquidatableWithEB(clusterId, burnRate, ethNetworkFee, minimumBlocksBeforeLiquidation, minimumLiquidationCollateral)) {
            liquidate(clusterOwner, operatorIds, cluster);
        }
    }

    function migrateClusterToETH(uint64[] calldata operatorIds, Cluster memory cluster) external payable {
        cluster.validatorCount += 1;
        ethValidatorCount += cluster.validatorCount;
        currentNetworkFeeIndex();
    }
}
`,
    },
  ]);

  assert.ok((graph.summary.byKind.evm_validator_cluster_accounting ?? 0) >= 12);
  assert.ok(
    graph.facts.some(
      (fact) => fact.kind === "evm_validator_cluster_accounting" && /updateClusterBalance/.test(fact.sourceExpression),
    ),
  );
  assert.ok(
    graph.obligations.some(
      (obligation) => obligation.id === "solidity-validator-cluster-fee-liquidation-conservation",
    ),
  );
});

test("Rust provenance extracts Solana OFT and governance facts", () => {
  const graph = extractRustSolanaProvenance([
    {
      path: "programs/oft/src/instructions/lz_receive.rs",
      kind: "source",
      content: `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, MintTo, TokenAccount};

#[derive(Accounts)]
pub struct LzReceive<'info> {
    #[account(mut, seeds = [b"OFT", oft_store.mint.as_ref()], bump = oft_store.bump)]
    pub oft_store: Account<'info, OFTStore>,
    #[account(mut, token::mint = mint, token::authority = recipient)]
    pub recipient_token: Account<'info, TokenAccount>,
    pub endpoint_program: Program<'info, Endpoint>,
}

pub fn apply(ctx: &mut Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
    let peer = ctx.accounts.oft_store.peer(params.src_eid)?;
    require!(peer.address == params.sender, ErrorCode::InvalidPeer);
    let amount_ld = sd2ld(params.amount_sd, ctx.accounts.oft_store.shared_decimals);
    let seeds = &[b"OFT", ctx.accounts.oft_store.mint.as_ref(), &[ctx.accounts.oft_store.bump]];
    token::mint_to(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo { mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.recipient_token.to_account_info(), authority: ctx.accounts.oft_store.to_account_info() },
        &[seeds],
    ), amount_ld)?;
    oapp::endpoint_cpi::clear(ctx.accounts.endpoint_program.to_account_info(), params.guid)?;
    Ok(())
}
`,
    },
    {
      path: "programs/governance/src/instructions/lz_receive.rs",
      kind: "source",
      content: `
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct LzReceive<'info> {
    #[account(seeds = [b"Governance"], bump = governance.bump)]
    pub governance: Account<'info, Governance>,
    /// CHECK: replaced by CPI authority
    pub cpi_authority: UncheckedAccount<'info>,
}

pub fn apply(ctx: &mut Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
    let remote = ctx.accounts.governance.remote(params.src_eid)?;
    require!(remote.address == params.sender, ErrorCode::InvalidRemote);
    let instruction = decode_governance_instruction(&params.message)?;
    solana_program::program::invoke_signed(&instruction, ctx.remaining_accounts, &[&[b"CpiAuthority", &[ctx.accounts.governance.bump]]])?;
    Ok(())
}
`,
    },
  ]);

  assert.equal(graph.domain, "solana-rust");
  assert.ok((graph.summary.byKind.solana_anchor_account ?? 0) >= 4);
  assert.ok((graph.summary.byKind.solana_pda_derivation ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_token_accounting ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_cpi_call ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_cross_chain_message ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_governance_execution ?? 0) >= 2);
  assert.ok((graph.summary.byKind.solana_decimal_conversion ?? 0) >= 1);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solana-anchor-account-constraint-integrity"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solana-layerzero-message-peer-replay-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "solana-governance-execution-account-authority"));
});

test("Rust ZK provenance extracts proof task and verifier binding facts", () => {
  const graph = extractRustZkProvenance([
    {
      path: "crates/libzkp/src/tasks/chunk.rs",
      kind: "source",
      content: `
pub struct ChunkTask {
    pub block_hashes: Vec<B256>,
}

impl TryFromWithInterpreter<ChunkTask> for ChunkProvingTask {
    fn try_from_with_interpret(value: ChunkTask, interpreter: impl ChunkInterpreter) -> Result<Self> {
        let mut block_witnesses = Vec::new();
        for block_hash in value.block_hashes {
            let witness = interpreter.try_fetch_block_witness(block_hash, block_witnesses.last())?;
            block_witnesses.push(witness);
        }
        Ok(Self { block_witnesses })
    }
}

impl ChunkProvingTask {
    pub fn into_proving_task_with_precheck(self) -> Result<(ProvingTask, ChunkInfo, B256)> {
        let (witness, metadata, pi_hash) = self.precheck()?;
        let serialized_witness = encode_task_to_witness(&witness)?;
        Ok((ProvingTask { serialized_witness, aggregated_proofs: vec![] }, metadata, pi_hash))
    }
}
`,
    },
    {
      path: "coordinator/internal/logic/submitproof/proof.go",
      kind: "source",
      content: `
func SubmitProof(taskID string, proof *ProofResult, metadata *ProofMetadata) error {
    return verifier.VerifyProof(taskID, proof, metadata)
}
`,
    },
  ]);

  assert.equal(graph.domain, "zk-proof-orchestration");
  assert.ok((graph.summary.byKind.zk_witness_source ?? 0) >= 3);
  assert.ok((graph.summary.byKind.zk_task_statement ?? 0) >= 2);
  assert.ok((graph.summary.byKind.zk_public_input_metadata ?? 0) >= 2);
  assert.ok((graph.summary.byKind.zk_proof_aggregation ?? 0) >= 1);
  assert.ok((graph.summary.byKind.zk_verifier_submission ?? 0) >= 2);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "zk-witness-source-request-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "zk-public-input-metadata-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "zk-verifier-submission-task-binding"));
});

test("Go Wormhole provenance extracts guardian, VAA, governor, and watcher facts", () => {
  const graph = extractGoWormholeProvenance([
    {
      path: "node/pkg/processor/processor.go",
      kind: "source",
      content: `
package processor

func handleObservation(obs *gossipv1.SignedObservation, gs *GuardianSet) error {
    msg := &MessagePublication{
        EmitterAddress: obs.EmitterAddress,
        Sequence: obs.Sequence,
        ConsistencyLevel: obs.ConsistencyLevel,
        TxHash: obs.TxHash,
    }
    digest := msg.SigningDigest()
    if !VerifyQuorum(gs, obs.Signatures, digest) {
        return errNoQuorum
    }
    signedVAA := AddSignature(&VAA{GuardianSetIndex: gs.Index, BodyHash: digest}, obs.Signature)
    Broadcast(signedVAA)
    return nil
}
`,
    },
    {
      path: "node/pkg/governor/governor.go",
      kind: "source",
      content: `
package governor

func (g *ChainGovernor) CheckTransfer(xfer TransferDetails) bool {
    notional := g.tokenPrice(xfer.Token) * xfer.Amount
    if notional > g.dailyLimit(xfer.EmitterChain) {
        g.Enqueue(xfer)
        return false
    }
    return g.Release(xfer)
}
`,
    },
    {
      path: "node/pkg/watchers/evm/watcher.go",
      kind: "source",
      content: `
package evm

func (w *Watcher) Run() error {
    for log := range w.PollFinalizedBlocks() {
        publication := ParseLogMessagePublished(log, w.chainID)
        publication.TxHash = log.TxHash
        publication.SourceChain = w.chainID
        w.reobserve <- publication
    }
    return nil
}
`,
    },
    {
      path: "node/cmd/guardiand/admin.go",
      kind: "source",
      content: `
package main

func updateConfig(admin *AdminClient, cfg *Config) error {
    if cfg.unsafeDevMode {
        return admin.SetGuardianKey(cfg.GuardianKey)
    }
    return admin.UpdateRPC(cfg.publicRPC)
}
`,
    },
  ]);

  assert.equal(graph.domain, "go-wormhole");
  assert.ok((graph.summary.byKind.go_wormhole_guardian_observation ?? 0) >= 1);
  assert.ok((graph.summary.byKind.go_wormhole_vaa_signing ?? 0) >= 4);
  assert.ok((graph.summary.byKind.go_wormhole_governor ?? 0) >= 3);
  assert.ok((graph.summary.byKind.go_wormhole_p2p_message ?? 0) >= 2);
  assert.ok((graph.summary.byKind.go_wormhole_chain_watcher ?? 0) >= 2);
  assert.ok((graph.summary.byKind.go_wormhole_admin_config ?? 0) >= 2);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "go-wormhole-observation-source-message-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "go-wormhole-vaa-signature-quorum-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "go-wormhole-governor-queued-transfer-integrity"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "go-wormhole-p2p-message-auth-dedup-domain"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "go-wormhole-chain-watcher-finality-reorg-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "go-wormhole-admin-config-authority-boundary"));
});

test("Cairo provenance extracts Starknet OS and bridge routing facts", () => {
  const graph = extractCairoStarknetProvenance([
    {
      path: "starkware/starknet/core/os/execution/syscall_impls.cairo",
      kind: "source",
      content: `
from starkware.common.dict import dict_read, dict_update

func execute_storage_write{range_check_ptr, syscall_ptr: felt*, contract_state_changes: DictAccess*}(
    caller_execution_context: ExecutionContext*
) {
    let request = cast(syscall_ptr + RequestHeader.SIZE, StorageWriteRequest*);
    let success = reduce_syscall_gas_and_write_response_header(
        total_gas_cost=STORAGE_WRITE_GAS_COST, request_struct_size=StorageWriteRequest.SIZE
    );
    let (state_entry: StateEntry*) = dict_read{dict_ptr=contract_state_changes}(
        key=caller_execution_context.execution_info.contract_address
    );
    assert [state_entry.storage_ptr] = DictAccess(
        key=request.key, prev_value=prev_value, new_value=request.value
    );
    dict_update{dict_ptr=contract_state_changes}(
        key=caller_execution_context.execution_info.contract_address,
        prev_value=cast(state_entry, felt),
        new_value=cast(new StateEntry(class_hash=state_entry.class_hash, storage_ptr=state_entry.storage_ptr, nonce=state_entry.nonce), felt),
    );
}
`,
    },
    {
      path: "packages/bridge/src/token_bridge.cairo",
      kind: "source",
      content: `
#[starknet::contract]
pub mod TokenBridge {
    use starknet::syscalls::{deploy_syscall, send_message_to_l1_syscall};

    #[storage]
    struct Storage {
        l1_bridge: EthAddress,
        erc20_class_hash: ClassHash,
        l1_l2_token_map: Map<EthAddress, ContractAddress>,
        l2_l1_token_map: Map<ContractAddress, EthAddress>,
        l1_locked_amount: Map<EthAddress, LockedAmount>,
    }

    #[l1_handler]
    fn handle_token_deployment(ref self: ContractState, from_address: felt252, l1_token: EthAddress, amount: u256) {
        self.only_from_l1_bridge(:from_address);
        let class_hash = self.erc20_class_hash.read();
        assert(class_hash.is_non_zero(), Errors::CLASS_HASH_NOT_SET);
        let (deployed_l2_token, _) = deploy_syscall(class_hash, l1_token.into(), calldata.span(), false).unwrap_syscall();
        self.l1_l2_token_map.write(l1_token, deployed_l2_token);
        self.l2_l1_token_map.write(deployed_l2_token, l1_token);
        self.l1_locked_amount.write(l1_token, LockedAmount { monitoring_enabled: true, amount });
    }

    fn initiate_token_withdraw(ref self: ContractState, l1_token: EthAddress, l1_recipient: EthAddress, amount: u256) {
        let l1_bridge_address = self.l1_bridge.read();
        IMintableTokenDispatcher { contract_address: l2_token }.permissioned_burn(account: caller_address, :amount);
        let result = send_message_to_l1_syscall(to_address: l1_bridge_address.into(), payload: message_payload.span());
        assert(result.is_ok(), Errors::MESSAGE_SEND_FAILED);
    }
}
`,
    },
    {
      path: "packages/strk/src/eip712_utils.cairo",
      kind: "source",
      content: `
const LOCK_AND_DELEGATE_TYPE_HASH: felt252 = 123;

pub fn validate_signature(account: ContractAddress, hash: felt252, signature: Array<felt252>) {
    let is_valid_signature_felt = AccountABIDispatcher { contract_address: account }.is_valid_signature(:hash, :signature);
    assert(is_valid_signature_felt == starknet::VALIDATED, 'SIGNATURE_VALIDATION_FAILED');
}

fn lock_and_delegate_input_hash(delegatee: ContractAddress, amount: u256, nonce: felt252, expiry: u64) -> felt252 {
    pedersen_hash_span(array![
        LOCK_AND_DELEGATE_TYPE_HASH, delegatee.into(), amount.low.into(), nonce, expiry.into(),
    ].span())
}

fn replay_guard(ref self: ContractState, hash: felt252) {
    let is_known_hash = self.recorded_locks.read(hash);
    assert(!is_known_hash, 'SIGNED_REQUEST_ALREADY_USED');
    self.recorded_locks.write(hash, true);
}
`,
    },
    {
      path: "starkware/starknet/core/os/os.cairo",
      kind: "source",
      content: `
func execute_blocks{output_ptr: felt*, pedersen_ptr: HashBuiltin*, range_check_ptr}(
    n_blocks: felt, os_output_per_block_dst: OsOutput*, os_global_context: OsGlobalContext*
) {
    let (block_context: BlockContext*) = get_block_context(os_global_context=os_global_context);
    let (squashed_os_state_update, state_update_output) = state_update{hash_ptr=pedersen_ptr}(
        os_state_update=OsStateUpdate(
            contract_state_changes_start=contract_state_changes_start,
            contract_state_changes_end=contract_state_changes,
            contract_class_changes_start=contract_class_changes_start,
            contract_class_changes_end=contract_class_changes,
        ),
        should_allocate_aliases=should_allocate_aliases(),
    );
    assert os_output_per_block_dst[0] = OsOutput(
        header=get_block_os_output_header(block_context=block_context, state_update_output=state_update_output),
        squashed_os_state_update=squashed_os_state_update,
    );
}
`,
    },
  ]);

  assert.equal(graph.domain, "cairo-starknet");
  assert.ok((graph.summary.byKind.cairo_entrypoint ?? 0) >= 3);
  assert.ok((graph.summary.byKind.cairo_syscall ?? 0) >= 3);
  assert.ok((graph.summary.byKind.cairo_storage_access ?? 0) >= 5);
  assert.ok((graph.summary.byKind.cairo_l1_l2_message ?? 0) >= 5);
  assert.ok((graph.summary.byKind.cairo_signature_hash_binding ?? 0) >= 5);
  assert.ok((graph.summary.byKind.cairo_class_hash_binding ?? 0) >= 4);
  assert.ok((graph.summary.byKind.cairo_resource_accounting ?? 0) >= 4);
  assert.ok((graph.summary.byKind.cairo_block_context ?? 0) >= 1);
  assert.ok((graph.summary.byKind.cairo_os_output_commitment ?? 0) >= 2);
  assert.ok((graph.summary.byKind.cairo_assertion_or_constraint ?? 0) >= 2);
  assert.ok(graph.obligations.some((obligation) => obligation.id === "cairo-l1-l2-message-origin-payload-accounting"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "cairo-signature-hash-full-payload-binding"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "cairo-storage-dict-state-commitment-integrity"));
  assert.ok(graph.obligations.some((obligation) => obligation.id === "cairo-os-output-state-root-message-commitment"));

  const rendered = renderProvenanceGraph(graph);
  assert.match(rendered, /Domain: cairo-starknet/);
  assert.match(rendered, /cairo_syscall/);
  assert.match(rendered, /cairo_signature_hash_binding/);
  assert.match(rendered, /send_message_to_l1_syscall/);
});

test("proof obligations combine corpus, learning, and provenance facts", () => {
  const graph = extractHalo2Provenance([
    {
      path: "chip/example.rs",
      kind: "source",
      content: 'fn assign(region: &mut Region, row: usize, base: Value) { region.assign_advice(|| "base", self.base, row, || base)?; }',
    },
  ]);
  const obligations = extractProofObligations({
    source: [],
    corpus: [
      {
        path: "book/nullifiers.md",
        kind: "corpus",
        content: "The circuit must check that the diversified public key equals the viewing-key multiplication result.",
      },
    ],
    projectLearning: {
      candidateInvariants: ["Witness values that affect a checked statement should be enforced by visible equations."],
      evidenceRefs: ["book/nullifiers.md:1"],
    },
    provenanceGraphs: [graph],
  });

  assert.ok(obligations.some((obligation) => obligation.kind === "spec"));
  assert.ok(obligations.some((obligation) => obligation.kind === "learning"));
  assert.ok(obligations.some((obligation) => obligation.kind === "provenance"));
  assert.ok(obligations.every((obligation) => obligation.evidenceRefs.every((ref) => !ref.startsWith("/"))));
});
