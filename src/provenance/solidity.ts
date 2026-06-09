import type { Doc, ProofObligation, ProvenanceFact, ProvenanceFactKind, ProvenanceGraph } from "../types.js";

const SIGNAL_TERMS = [
  "asset",
  "agreement",
  "async",
  "balance",
  "beacon",
  "bridge",
  "bus",
  "burn rate",
  "cluster",
  "credit",
  "delegate",
  "delegatecall",
  "erc20",
  "endpoint",
  "erc4626",
  "executor",
  "fee",
  "flash",
  "governance",
  "guardian",
  "guardian set",
  "effective balance",
  "emitter",
  "proposal",
  "quorum",
  "allowlist",
  "auth function",
  "fallback",
  "guid",
  "hydra",
  "hyperlane",
  "initializer",
  "interchain",
  "ism",
  "layerzero",
  "liquidation",
  "lzreceive",
  "lzsend",
  "mailbox",
  "metadata",
  "max claim",
  "name",
  "name wrapper",
  "namehash",
  "merkle",
  "accountant",
  "cooldown",
  "collateral",
  "custodian",
  "decimals",
  "eip1271",
  "eip712",
  "deadline",
  "global",
  "mint",
  "native drop",
  "order",
  "oracle",
  "oft",
  "operator",
  "payer",
  "payment",
  "permit2",
  "permit",
  "proxy",
  "redeem",
  "registrar",
  "registry",
  "receiver",
  "receiverdestination",
  "restricted",
  "refund",
  "request",
  "recurring",
  "resolver",
  "remote router",
  "root",
  "shares",
  "solver",
  "settler",
  "selector",
  "slippage",
  "spell",
  "staker",
  "stable",
  "stargate",
  "starguard",
  "storage",
  "subproxy",
  "subname",
  "supply",
  "timelock",
  "ticket",
  "transfer",
  "transient",
  "msg.data",
  "msg.sig",
  "unit",
  "upgrade",
  "vaa",
  "wrapped name",
  "validator",
  "vunit",
  "vault",
  "vote",
  "voting",
  "whitelist",
  "witness",
  "withdraw",
];

export function extractSolidityProvenance(source: Doc[]): ProvenanceGraph {
  const facts: ProvenanceFact[] = [];
  let files = 0;
  for (const doc of source) {
    if (!looksLikeSolidityDoc(doc)) continue;
    files += 1;
    facts.push(...extractFactsFromDoc(doc));
  }
  const obligations = solidityRoutingObligations(facts);
  return {
    domain: "solidity",
    facts,
    obligations,
    summary: {
      files,
      facts: facts.length,
      byKind: countBy(facts, (fact) => fact.kind),
      assignmentFlowObligations: obligations.length,
    },
  };
}

function extractFactsFromDoc(doc: Doc): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const code = stripInlineComment(line).trim();
    if (code.length === 0) continue;
    const functionName = enclosingFunction(lines, idx);
    const nearbySignals = nearbySignalsFor(lines, idx);
    for (const fact of factsFromLine(doc.path, idx + 1, code, functionName, nearbySignals)) {
      out.push(fact);
    }
  }
  return out;
}

function factsFromLine(
  path: string,
  line: number,
  code: string,
  functionName: string | undefined,
  nearbySignals: string[],
): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const common = { path, line, functionName, nearbySignals, code };

  const functionMatch = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*([^;{]*)/.exec(code);
  if (functionMatch) {
    const signature = oneLine(`${functionMatch[1]}(${functionMatch[2] ?? ""}) ${functionMatch[3] ?? ""}`);
    if (/\b(external|public)\b/.test(functionMatch[3] ?? "")) {
      out.push(fact({ ...common, kind: "evm_external_function", label: functionMatch[1], sourceExpression: signature }));
    }
    if (/\b(initializer|reinitializer|onlyProxy|upgradeTo|upgradeToAndCall)\b/i.test(code)) {
      out.push(fact({ ...common, kind: "evm_upgrade_hook", label: functionMatch[1], sourceExpression: signature }));
    }
  }

  if (/\b(receive|fallback)\s*\(/.test(code)) {
    out.push(fact({ ...common, kind: "evm_external_function", label: "fallback_or_receive", sourceExpression: code }));
  }

  if (/\b(require|if)\s*\([^)]*(msg\.sender|hasRole|owner\(\)|_owner|onlyOwner|onlyRole|AccessControl)/i.test(code) || /\bonly[A-Za-z0-9_]*\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_auth_guard", sourceExpression: code }));
  }

  if (/\.delegatecall\s*\(/.test(code)) {
    out.push(fact({ ...common, kind: "evm_delegatecall", sourceExpression: code }));
  }

  if (/\.(call|staticcall|transfer|send)\s*(?:\{|\.|\()/.test(code)) {
    out.push(fact({ ...common, kind: "evm_external_call", sourceExpression: code }));
  }

  if (looksLikeSelectorForwardingLine(code, nearbySignals)) {
    out.push(fact({ ...common, kind: "evm_selector_forwarding", sourceExpression: code }));
  }

  if (looksLikeRecurringAgreementLine(code, nearbySignals)) {
    out.push(fact({ ...common, kind: "evm_recurring_agreement", sourceExpression: code }));
  }

  if (looksLikePaymentDistributionLine(code, nearbySignals)) {
    out.push(fact({ ...common, kind: "evm_payment_distribution", sourceExpression: code }));
  }

  if (/\b(safeTransferFrom|transferFrom|safeTransfer|transfer|_mint|_burn|mint|burn)\s*\(/.test(code)) {
    out.push(fact({ ...common, kind: "evm_token_transfer", sourceExpression: code }));
  }

  if (/\b(?:_lzSend|lzReceive|_lzReceive|sendCompose|isComposeMsgSender|Origin|OApp|endpoint|peers?|setPeer|quoteTaxi|taxi|rideBus|driveBus|encodeTaxi|decodeTaxi|encodeBus|decodeBus|encode\(|decode\(|publishMessage|parseAndVerifyVM|completeTransfer|completeTransferWithPayload|TransferRedeemed)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_message", sourceExpression: code }));
  }

  if (
    /\b(?:Wormhole|IWormhole|VAA|vaa|VM|encodedVM|encodedVm|parseAndVerifyVM|parseVM|verifyVM|verifyVMInternal|verifySignatures|guardianSet|guardianSets|guardianSetIndex|getCurrentGuardianSetIndex|governanceActionIsConsumed|governanceActionsConsumed|consumeGovernanceAction|publishMessage|LogMessagePublished|emitterChainId|emitterAddress|sequence|consistencyLevel|quorum|bridgeContracts|TransferRedeemed)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_wormhole_vaa", sourceExpression: code }));
  }

  if (
    /\b(?:Mailbox|IMailbox|mailbox|dispatch|process|IMessageRecipient|handle|IInterchainSecurityModule|InterchainSecurityModule|ISM|interchainSecurityModule|moduleType|metadata|messageId|latestDispatchedId|delivered|recipientIsm|defaultIsm|postDispatch|quoteDispatch|InterchainGasPaymaster|IGP)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_bridge_message", sourceExpression: code }));
  }

  if (/\b(?:assetId|assetIds|stargateImpls|setAssetId|_safeGetAssetId|_safeGetStargateImpl|maxAssetId|localEid|dstEid|srcEid)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_asset_mapping", sourceExpression: code }));
  }

  if (
    /\b(?:remoteRouter|remoteRouters|enrolledRouters|enrollRemoteRouter|unenrollRemoteRouter|localDomain|destinationDomain|originDomain|HypERC20|HypERC721|TokenRouter|Router|WarpRoute|warp route)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_bridge_asset_mapping", sourceExpression: code }));
  }

  if (/\b(?:paths|credit|credits|sendCredits|receiveCredits|increaseCredit|decreaseCredit|tryDecreaseCredit|burnCredit|UNLIMITED_CREDIT|PathLib|deficit|poolBalance|tvlSD|treasuryFee|applyFee|SendParam|OFTReceipt|quoteOFT|quoteSend|amountLD|amountSD|amountSentLD|amountReceivedLD|minAmountLD|minAmountOut)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_credit_accounting", sourceExpression: code }));
  }

  if (
    /\b(?:payForGas|quoteGasPayment|gasPayment|interchainGasPaymaster|requiredHook|defaultHook|hook|hooks|postDispatch|quoteDispatch|warpRoute|collateralToken|syntheticToken|xERC20|TokenMessage|formatTokenMessage|parseTokenMessage|validatorsAndThreshold|validatorThreshold|checkpoint|merkleRoot|signedCheckpoint|threshold|validators)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_bridge_credit_accounting", sourceExpression: code }));
  }

  if (/\b(?:nativeDrop|nativeDropAmount|totalNativeDrops|transferNative|safeTransferNative|plannerFee|refundAddress|busFare|fare)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_bridge_native_drop", sourceExpression: code }));
  }

  if (/\b(?:OFT|IOFT|IERC20Minter|mint|burn|burnFrom|_capReward|_inflow|_outflow|sharedDecimals|convertRate|ld2sd|sd2ld|amountLD|amountSD)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_oft_supply_change", sourceExpression: code }));
  }

  if (/\b(ecrecover|ECDSA\.recover|_hashTypedDataV4|DOMAIN_SEPARATOR|permit|nonces?|isValidSignature|IERC1271|EIP1271_MAGICVALUE)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_signature_check", sourceExpression: code }));
  }

  if (
    /\b(?:Permit2|ISignatureTransfer|SignatureTransfer|PermitTransferFrom|permitWitnessTransferFrom|permitTransferFrom|_transferFrom|_permitToTransferDetails|_permitToSellAmount|witness|WITNESS|FULL_PERMIT2_WITNESS_TYPEHASH|_witnessTypeSuffix|_hashArrayOfBytes|_hashActionsAndSlippage|_hashSlippage|metaTx)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_permit2_witness_binding", sourceExpression: code }));
  }

  if (
    /\b(?:ISettlerActions|_dispatchVIP|_dispatch\(|decodeCall|actions\.decodeCall|revertActionInvalid|executeMetaTxn|_executeMetaTxn|execute\(|uint32\(ISettlerActions|action\s*==|actions\.length|VIP|METATXN_|TRANSFER_FROM|RFQ_VIP|UNISWAPV3_VIP|BASIC)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_settler_action_dispatch", sourceExpression: code }));
  }

  if (
    /\b(?:AllowedSlippage|SLIPPAGE_TYPEHASH|SLIPPAGE_AND_ACTIONS_TYPEHASH|_hashActionsAndSlippage|_hashSlippage|_checkSlippageAndTransfer|_mandatorySlippageCheck|TooMuchSlippage|amountOutMin|minAmountOut|minBuyAmount|slippage|transferExactLimit|POSITIVE_SLIPPAGE|rebateClaimer)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_settler_slippage_binding", sourceExpression: code }));
  }

  if (
    /\b(?:CalldataDecoder|decodeCall|calldataload|calldatacopy|args\.offset|args\.length|actions\.offset|data\.offset|negative offsets?|calldata alias|alias other parts|run off the end|implicitly padded)\b/i.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_settler_calldata_decoder", sourceExpression: code }));
  }

  if (
    /\b(?:TransientStorage|_PAYER_SLOT|_OPERATOR_SLOT|_WITNESS_SLOT|setPayer|clearPayer|payer|_operator\(|_msgSender\(|_isForwarded\(|tstore|tload|metaTx|takerSubmitted|MultiCallContext|callback selector|callback function pointer)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_settler_transient_context", sourceExpression: code }));
  }

  if (
    /\b(?:_isRestrictedTarget|isRestrictedTarget|revertConfusedDeputy|ConfusedDeputy|InvalidTarget|restricted target|FULL_RESTRICTED|SOFT_RESTRICTED|_msgSender\(\)|BASIC|basicSellToPool|pool\.code\.length|onlyProxy|noDelegateCall)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_settler_restricted_target", sourceExpression: code }));
  }

  if (
    /\b(?:selfbalance\(\)|address\(this\)\.balance|fastBalanceOf\(address\(this\)\)|BRIDGE_NATIVE_TO_RELAY|BRIDGE_ERC20_TO_RELAY|bridgeNativeToRelay|bridgeERC20ToRelay|BRIDGE_TO_NUCLEUS_TELLER|bridgeToNucleusTeller|BRIDGE_TO_CCIP|bridgeToCCIP|BRIDGE_TO_LAYER_ZERO_OFT|bridgeLayerZeroOFT)\b/i.test(
      code,
    )
    && /\b(?:bridge|settler|relay|refund|native|fee|balance|selfbalance|full)\b/i.test(`${code} ${nearbySignals.join(" ")}`)
  ) {
    out.push(fact({ ...common, kind: "evm_settler_full_balance_bridge_sink", sourceExpression: code }));
  }

  if (/\b(?:IERC1271|isValidSignature|EIP1271|EIP1271_MAGICVALUE|SignatureType\.EIP1271|InvalidEIP1271Signature)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_eip1271_signature", sourceExpression: code }));
  }

  if (
    /\b(?:mint|redeem|Mint|Redeem|Order|order|order_id|verifyOrder|verifyRoute|route|custodian|custody|collateral|beneficiary|benefactor|notional|price|EIP712|EIP1271|_hashTypedDataV4|verifyNonce|nonce|deadline|expiry)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_mint_redeem_order", sourceExpression: code }));
  }

  if (
    /\b(?:requestDeposit|requestRedeem|solveRequestsVault|solveRequestsDirect|solveRequests|refundRequest|refundDeposit|asyncDepositHashes|asyncRedeemHashes|syncDepositHashes|RequestType|TokenDetails|PriceType|solver|solverTip|deadline|maxPriceAge|depositCap|userUnitsRefundableUntil|areUserUnitsLocked|Provisioner|provisioner|unitPrice|unitsAmount|tokensAmount|convertTokenToUnits|convertUnitsToToken|_getRequestHash|_getDepositHash)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_async_request_settlement", sourceExpression: code }));
  }

  if (
    /\b(?:whitelistedBenefactors|_whitelistedBenefactors|addWhitelistedBenefactor|removeWhitelistedBenefactor|isWhitelistedBenefactor|approvedBeneficiaries|_approvedBeneficiariesPerBenefactor|setApprovedBeneficiary|isApprovedBeneficiary|BenefactorNotWhitelisted|BeneficiaryNotApproved|BeneficiaryAdded|BeneficiaryRemoved)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_beneficiary_allowlist", sourceExpression: code }));
  }

  if (
    /\b(?:verifyStablesLimit|stablesDeltaLimit|STABLES_RATIO_MULTIPLIER|TokenType\.STABLE|InvalidStablePrice|collateralDecimals|usdeDecimals|normalizedCollateralAmount|differenceInBps|_getDecimals|decimals\(\)|tokenType)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_stable_price_limit", sourceExpression: code }));
  }

  if (
    /\b(?:maxMintPerBlock|maxRedeemPerBlock|globalMaxMintPerBlock|globalMaxRedeemPerBlock|totalPerBlock|totalPerBlockPerAsset|BlockTotals|GlobalConfig|belowGlobalMax|belowMaxMintPerBlock|belowMaxRedeemPerBlock|disableMintRedeem)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_block_limit", sourceExpression: code }));
  }

  if (
    /\b(?:StarGuard|StarSpell|SubProxy|spellData|plot|drop|exec|isExecutable|codehash|deadline|maxDelay|wards|Rely|Deny|delegatecall)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_governance_payload", sourceExpression: code }));
  }

  if (
    /\b(?:GovPool|GovValidators|GovUserKeeper|GovSettings|Proposal|proposal|proposalId|latestProposalId|createProposal|executeProposal|moveProposalToValidators|vote|voteFor|voteAgainst|VoteType|votesFor|votesAgainst|rawPower|votingPower|power|quorum|quorumReached|threshold|validator|validators|micropool|delegat|undelegat|lockVotes|canCreate|canVote|canExecute|proposalState|ProposalState|settingsId|executor|distribution|rewardAddress|ERC721Expert|multiplier)\b/i.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_dao_governance", sourceExpression: code }));
  }

  if (looksLikeNameRegistryLine(code)) {
    out.push(fact({ ...common, kind: "evm_name_registry_resolution", sourceExpression: code }));
  }

  if (
    /\b(?:SSVNetwork|SSVClusters|SSVValidators|SSVOperators|SSVViews|ClusterLib|OperatorLib|ProtocolLib|operatorIds|ClusterEBSnapshot|clusterEB|operatorEthVUnits|effectiveBalance|vUnits|validatorCount|ethValidatorCount|burnRate|updateClusterBalance|registerValidator|bulkRegisterValidator|removeValidator|bulkRemoveValidator|exitValidator|migrateClusterToETH|reactivate|liquidate|updateClusterOperators|updateDAOEthVUnits|minimumBlocksBeforeLiquidation|minimumLiquidationCollateral|currentNetworkFeeIndex|ethNetworkFee|networkTotalEarnings|daoTotalEthVUnits|ethDaoBalance|ebRoots|latestCommittedBlock|minBlocksBetweenUpdates|MerkleProof|RootNotFound|MustUseLatestRoot|StaleUpdate|EBExceedsMaximum|EBBelowMinimum|OperatorFee|withdrawOperatorEarnings|declareOperatorFee|executeOperatorFee)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_validator_cluster_accounting", sourceExpression: code }));
  }

  if (
    /\b(?:ERC4626|deposit|withdraw|redeem|mint|cooldown|cooldowns?|silo|totalAssets|convertToShares|previewDeposit|previewWithdraw|previewRedeem|shares|asset\(\)|maxWithdraw|maxRedeem)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_erc4626_cooldown", sourceExpression: code }));
  }

  if (
    /\b(?:FULL_RESTRICTED|SOFT_RESTRICTED|BLACKLIST|allowlist|whitelist|blacklist|restricted|restriction|hasRole|grantRole|revokeRole|renounceRole|onlyRole|MINTER_ROLE|REDEEMER_ROLE|GATEKEEPER|custodian)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "evm_restriction_role", sourceExpression: code }));
  }

  if (/\b(latestRoundData|getRoundData|getPrice|priceFeed|oracle|twap|answer|sequencer)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "evm_oracle_read", sourceExpression: code }));
  }

  if (/\b(upgradeTo|upgradeToAndCall|_authorizeUpgrade|initializer|reinitializer|proxiableUUID|__gap)\b/.test(code)) {
    out.push(fact({ ...common, kind: "evm_upgrade_hook", sourceExpression: code }));
  }

  if (/\bunchecked\s*\{/.test(code)) {
    out.push(fact({ ...common, kind: "evm_unchecked_arithmetic", sourceExpression: code }));
  }

  if (looksLikeStateWrite(code)) {
    out.push(fact({ ...common, kind: "evm_state_write", sourceExpression: code }));
  }

  return out;
}

function solidityRoutingObligations(facts: ProvenanceFact[]): ProofObligation[] {
  const obligations: ProofObligation[] = [];
  pushObligation(obligations, facts, "evm_external_call", {
    id: "solidity-external-call-state-finalization",
    property:
      "External calls and callbacks should be audited with local state, accounting, reentrancy guard, and return-value handling in the same transaction boundary.",
    keywords: ["external call", "reentrancy", "callback", "accounting"],
  });
  pushObligation(obligations, facts, "evm_delegatecall", {
    id: "solidity-delegatecall-storage-and-auth",
    property:
      "Delegatecall and proxy execution paths should be tied to explicit authorization and storage-layout compatibility assumptions.",
    keywords: ["delegatecall", "proxy", "storage", "authorization"],
  });
  pushObligation(obligations, facts, "evm_selector_forwarding", {
    id: "solidity-selector-forwarding-allowlist-collision",
    property:
      "Fallback, router, or manager paths that forward msg.data by msg.sig should bind selector, caller, target, calldata, value, and local function collisions so a selector allowlist cannot route an authorized caller into an unintended asset-moving function.",
    keywords: ["selector", "fallback", "msg.sig", "msg.data", "function allowlist", "collision"],
    priorityPathPattern: /\b(?:Wallet|Manager|Forwarder|Router|Proxy|TokenLock|Authoriz|Managed)\b/i,
    priorityPattern: /\b(?:fallback|getAuthFunctionCallTarget|setAuthFunctionCall|authFnCalls|msg\.sig|msg\.data|functionCall)\b/i,
  });
  pushObligation(obligations, facts, "evm_recurring_agreement", {
    id: "solidity-recurring-agreement-authorization-accounting",
    property:
      "Recurring agreement collectors should bind payer, data service, service provider, active and pending terms, signer or stored-offer authorization, cancellation scope, collection window, max claim, callbacks, and escrow side effects before agreement state advances or funds move.",
    keywords: ["recurring agreement", "payer", "stored offer", "cancellation", "collection window", "max claim"],
    priorityPathPattern: /\b(?:Recurring|Agreement|Collector|Payment|Escrow|DataService)\b/i,
    priorityPattern: /\b(?:RecurringCollectionAgreement|AgreementData|storedOffer|cancelledOffers|lastCollectionAt|getMaxNextClaim|beforeCollection|afterCollection|collect)\b/i,
  });
  pushObligation(obligations, facts, "evm_payment_distribution", {
    id: "solidity-payment-distribution-route-binding",
    property:
      "Payment distribution paths should bind payer, collector, receiver, data service, protocol cut, service cut, delegation-pool cut, receiver destination, escrow balance deltas, and rounding order so one participant cannot redirect or over-collect another participant's payment share.",
    keywords: ["payment distribution", "receiver destination", "data service cut", "delegation pool", "escrow"],
    priorityPathPattern: /\b(?:GraphPayments|PaymentsEscrow|Payment|Escrow|Collector|DataService)\b/i,
    priorityPattern: /\b(?:receiverDestination|dataServiceCut|PROTOCOL_PAYMENT_CUT|tokensDataService|tokensDelegationPool|EscrowCollected|GraphPaymentCollected|stakeTo|addToDelegationPool|escrowBalanceBefore)\b/i,
  });
  pushObligation(obligations, facts, "evm_upgrade_hook", {
    id: "solidity-upgrade-initializer-storage",
    property:
      "Upgrade and initializer hooks should enforce authorization, single-use initialization, implementation compatibility, and storage-layout safety.",
    keywords: ["upgrade", "initializer", "storage layout", "proxy"],
  });
  pushObligation(obligations, facts, "evm_signature_check", {
    id: "solidity-signature-domain-replay",
    property:
      "Signature acceptance should bind signer, action, amount or authority, nonce, deadline, chain id, verifying contract, and domain separator.",
    keywords: ["signature", "permit", "nonce", "domain separator", "replay"],
  });
  pushObligation(obligations, facts, "evm_permit2_witness_binding", {
    id: "solidity-permit2-witness-action-binding",
    property:
      "Permit2 and metatransaction witness checks should bind signer, spender, payer, recipient, permit token and amount, nonce, deadline, witness type, slippage, and the exact ordered action bytes before user funds move.",
    keywords: ["permit2", "witness", "action bytes", "spender", "nonce", "deadline", "slippage"],
    priorityPathPattern: /\b(?:Permit2Payment|SettlerMetaTxn|SettlerIntent|ISettlerActions|Permit2Signature)\b/i,
    priorityPattern: /\b(?:permitWitnessTransferFrom|_transferFrom|_hashArrayOfBytes|_hashActionsAndSlippage|_hashSlippage|_witnessTypeSuffix|metaTx|PermitTransferFrom)\b/,
  });
  pushObligation(obligations, facts, "evm_settler_action_dispatch", {
    id: "solidity-settler-action-dispatch-integrity",
    property:
      "Settler action dispatch should enforce the intended first VIP action, ordered calldata bytes, selector validity, payer source, recipient, route parameters, and post-action payout so a relayer, solver, callback, or calldata alias cannot execute a different asset-moving route than the user authorized.",
    keywords: ["settler", "action dispatch", "vip action", "selector", "route", "recipient", "calldata"],
    priorityPathPattern: /\b(?:Settler|SettlerMetaTxn|SettlerIntent|SettlerBase|ISettlerActions|Common)\b/i,
    priorityPattern: /\b(?:_dispatchVIP|_dispatch\(|decodeCall|executeMetaTxn|_executeMetaTxn|revertActionInvalid|actions\.decodeCall|ISettlerActions)\b/,
  });
  pushObligation(obligations, facts, "evm_settler_slippage_binding", {
    id: "solidity-settler-slippage-payout-binding",
    property:
      "Settler slippage and payout checks should bind recipient, buy token, minimum amount, exact-limit behavior, positive-slippage recipient, and final balance delta to the user-signed or solver-constrained route before residual funds leave the contract.",
    keywords: ["settler", "slippage", "payout", "recipient", "minimum amount", "positive slippage"],
    priorityPathPattern: /\b(?:SettlerBase|SettlerMetaTxn|SettlerIntent|ISettlerActions|RebateClaimer)\b/i,
    priorityPattern: /\b(?:AllowedSlippage|_checkSlippageAndTransfer|_hashActionsAndSlippage|_hashSlippage|amountOutMin|minAmountOut|POSITIVE_SLIPPAGE)\b/,
  });
  pushObligation(obligations, facts, "evm_settler_calldata_decoder", {
    id: "solidity-settler-calldata-aliasing-boundary",
    property:
      "Custom calldata decoding that permits unchecked offsets, implicit zero padding, or action-array aliasing should be audited against every dispatch and witness hash consumer so malformed calldata cannot change the executed action relative to the hashed or validated bytes.",
    keywords: ["calldata decoder", "aliasing", "offset", "zero padding", "dispatch", "witness"],
    priorityPathPattern: /\b(?:SettlerBase|SettlerMetaTxn)\b/i,
    priorityPattern: /\b(?:CalldataDecoder|decodeCall|calldataload|args\.offset|actions\.offset|_hashArrayOfBytes)\b/,
  });
  pushObligation(obligations, facts, "evm_settler_transient_context", {
    id: "solidity-settler-transient-context-isolation",
    property:
      "Transient payer, operator, witness, and callback context should be set, consumed, and cleared across taker-submitted, metatransaction, intent, multicall, and callback paths so reentrancy or forwarding cannot confuse the asset owner or authorized operator.",
    keywords: ["transient storage", "payer", "operator", "witness", "callback", "msgSender"],
    priorityPathPattern: /\b(?:TransientStorage|Permit2Payment|Context|MultiCallContext|Settler|SettlerMetaTxn|SettlerIntent)\b/i,
    priorityPattern: /\b(?:setPayer|clearPayer|_operator|_msgSender|metaTx|takerSubmitted|_PAYER_SLOT|_OPERATOR_SLOT|_WITNESS_SLOT|tstore|tload)\b/,
  });
  pushObligation(obligations, facts, "evm_settler_restricted_target", {
    id: "solidity-settler-restricted-target-confused-deputy",
    property:
      "BASIC, callback, approval, multicall, proxy, and arbitrary target paths should enforce restricted-target policy at the final call target so user funds cannot be routed into Settler, Permit2, AllowanceHolder, proxy, or other protocol-critical contracts as a confused deputy.",
    keywords: ["restricted target", "BASIC", "confused deputy", "arbitrary call", "allowance holder", "permit2"],
    priorityPathPattern: /\b(?:Basic|Settler|Permit2Payment|AllowanceHolder|Context|MultiCall)\b/i,
    priorityPattern: /\b(?:_isRestrictedTarget|revertConfusedDeputy|basicSellToPool|InvalidTarget|onlyProxy|noDelegateCall|FULL_RESTRICTED|SOFT_RESTRICTED)\b/,
  });
  pushObligation(obligations, facts, "evm_settler_full_balance_bridge_sink", {
    id: "solidity-settler-full-balance-bridge-sweep",
    property:
      "Settler bridge, relay, and refund paths that consume selfbalance(), address(this).balance, or token.fastBalanceOf(address(this)) should prove residual native/token balances cannot be swept by unrelated later callers and that bridge refunds return to the originating payer or an authorized beneficiary.",
    keywords: ["settler", "bridge", "selfbalance", "refund", "full balance", "relay", "residual funds"],
    priorityPathPattern: /\b(?:BridgeSettler|Relay|NucleusTeller|LayerZero|CCIP|Mayan|Stargate|Across|DeBridge)\b/i,
    priorityPattern: /\b(?:selfbalance\(\)|address\(this\)\.balance|fastBalanceOf\(address\(this\)\)|BRIDGE_NATIVE_TO_RELAY|bridgeNativeToRelay|bridgeToNucleusTeller|bridgeToCCIP|bridgeLayerZeroOFT)\b/i,
  });
  pushObligation(obligations, facts, "evm_oracle_read", {
    id: "solidity-oracle-freshness-manipulation",
    property:
      "Oracle reads that influence value-sensitive state should validate freshness, decimals, positivity, sequencer or liveness assumptions, and manipulation resistance.",
    keywords: ["oracle", "price", "freshness", "manipulation", "decimals"],
  });
  pushObligation(obligations, facts, "evm_token_transfer", {
    id: "solidity-token-transfer-accounting",
    property:
      "Token movement should be reconciled with balance deltas, fee-on-transfer behavior, callback behavior, decimals, and value-conservation invariants.",
    keywords: ["token transfer", "balance delta", "fee-on-transfer", "value conservation"],
  });
  pushObligation(obligations, facts, "evm_unchecked_arithmetic", {
    id: "solidity-unchecked-arithmetic-bounds",
    property:
      "Unchecked arithmetic should be audited against visible preconditions that bound overflow, underflow, rounding, and precision loss.",
    keywords: ["unchecked", "overflow", "rounding", "precision"],
  });
  pushObligation(obligations, facts, "evm_external_function", {
    id: "solidity-public-entrypoint-state-invariants",
    property:
      "Externally callable state-changing entrypoints should be audited for authorization, pause or lifecycle constraints, replay protection, and state/accounting invariants.",
    keywords: ["external function", "authorization", "state transition", "invariant"],
  });
  pushObligation(obligations, facts, "evm_bridge_message", {
    id: "solidity-bridge-message-domain-and-payload-binding",
    property:
      "Bridge message send and receive paths should bind source chain, destination chain, peer, mailbox or endpoint, asset id, receiver, sender, amount, compose payload, metadata, nonce or ticket, refund, and message type before value is minted, released, or handled.",
    keywords: ["bridge message", "layerzero", "hyperlane", "payload", "mailbox", "peer", "replay", "receiver"],
  });
  pushObligation(obligations, facts, "evm_bridge_asset_mapping", {
    id: "solidity-bridge-asset-id-route-binding",
    property:
      "Bridge asset mappings should prevent asset-id, route, endpoint or mailbox, remote-router, and implementation confusion across local and remote pools, OFTs, or warp routes.",
    keywords: ["asset id", "route", "endpoint", "mailbox", "remote router", "stargate", "implementation"],
  });
  pushObligation(obligations, facts, "evm_bridge_credit_accounting", {
    id: "solidity-bridge-credit-and-liquidity-conservation",
    property:
      "Bridge credit, pool balance, treasury fee, hook or gas payment, reward, deficit, threshold metadata, and shared-decimal accounting should conserve value and authority across local settlement, remote release, verification, and planner-driven credit movement.",
    keywords: ["credit", "liquidity", "pool balance", "hook", "gas payment", "threshold", "shared decimals"],
  });
  pushObligation(obligations, facts, "evm_bridge_native_drop", {
    id: "solidity-bridge-native-drop-fee-isolation",
    property:
      "Native-drop, fare, refund, and planner-fee handling should keep user transfer value, execution gas value, and protocol fees isolated under failed receiver callbacks and partial delivery.",
    keywords: ["native drop", "fare", "refund", "planner fee", "callback"],
  });
  pushObligation(obligations, facts, "evm_wormhole_vaa", {
    id: "solidity-wormhole-vaa-guardian-emitter-binding",
    property:
      "Wormhole VAA acceptance and message publication paths should bind guardian-set index, guardian quorum, signature ordering, VAA body hash, emitter chain, emitter address, sequence, consistency level, governance chain/contract, replay consumption, and bridge-contract mapping before governance execution or token release.",
    keywords: ["wormhole", "vaa", "guardian set", "quorum", "emitter", "sequence", "governance", "replay"],
    priorityPathPattern: /\b(?:Messages|Governance|Bridge|NFTBridge|WormholeDelegatedGuardians|DelegatedManagerSet|IWormhole)\b/i,
    priorityPattern: /\b(?:parseAndVerifyVM|verifyVM|verifySignatures|guardianSetIndex|governanceActionIsConsumed|emitterChainId|emitterAddress|sequence|bridgeContracts|completeTransfer|publishMessage)\b/i,
  });
  pushObligation(obligations, facts, "evm_oft_supply_change", {
    id: "solidity-oft-mint-burn-lock-unlock-conservation",
    property:
      "OFT mint, burn, lock, unlock, dust removal, and shared-decimal conversion paths should preserve one-to-one supply and redemption invariants across chains.",
    keywords: ["oft", "mint", "burn", "lock", "unlock", "shared decimals"],
  });
  pushObligation(obligations, facts, "evm_mint_redeem_order", {
    id: "solidity-mint-redeem-order-collateral-binding",
    property:
      "Mint and redeem orders should bind signer, beneficiary, collateral asset, custodian route, amount, price, nonce, deadline, chain, verifying contract, and transfer direction before minting or releasing value.",
    keywords: ["mint", "redeem", "order", "collateral", "custodian", "nonce", "deadline"],
  });
  pushObligation(obligations, facts, "evm_async_request_settlement", {
    id: "solidity-async-request-solver-settlement-conservation",
    property:
      "Async deposit and redeem requests should bind user, token, units, price type, solver, tip, deadline, max price age, refund path, and vault settlement so direct or authorized solvers cannot steal, strand, or over-settle user assets.",
    keywords: ["async request", "solver", "refund", "deadline", "unit price", "vault settlement"],
    priorityPattern: /\b(?:requestDeposit|requestRedeem|solveRequests|refundRequest|refundDeposit|asyncDepositHashes|asyncRedeemHashes|_getRequestHash|areUserUnitsLocked|userUnitsRefundableUntil)\b/i,
  });
  pushObligation(obligations, facts, "evm_erc4626_cooldown", {
    id: "solidity-erc4626-cooldown-share-asset-conservation",
    property:
      "ERC4626 staking, cooldown, silo, deposit, withdraw, and redeem paths should preserve share-to-asset accounting under donations, vesting, rounding, restrictions, and time-based exits.",
    keywords: ["erc4626", "cooldown", "shares", "assets", "silo", "rounding"],
  });
  pushObligation(obligations, facts, "evm_restriction_role", {
    id: "solidity-role-restriction-transfer-and-privilege-boundaries",
    property:
      "Role, allowlist, blacklist, restriction, minter, redeemer, gatekeeper, and custodian controls should be enforced at every asset-moving entrypoint and should not be bypassable through transfers, approvals, relayers, or alternate call paths.",
    keywords: ["role", "restriction", "allowlist", "blacklist", "minter", "redeemer", "custodian"],
  });
  pushObligation(obligations, facts, "evm_eip1271_signature", {
    id: "solidity-eip1271-contract-signature-boundary",
    property:
      "EIP-1271 contract signature checks should bind the intended contract benefactor, action, nonce, domain, and beneficiary while containing callback side effects during signature validation.",
    keywords: ["eip1271", "contract signature", "benefactor", "callback", "nonce"],
  });
  pushObligation(obligations, facts, "evm_beneficiary_allowlist", {
    id: "solidity-benefactor-beneficiary-allowlist-binding",
    property:
      "Benefactor whitelists and beneficiary approvals should be enforced before value movement and should not be bypassable through delegated signers, contract signatures, relayers, or stale approvals.",
    keywords: ["benefactor", "beneficiary", "whitelist", "approval", "delegated signer"],
  });
  pushObligation(obligations, facts, "evm_stable_price_limit", {
    id: "solidity-stable-price-decimal-limit",
    property:
      "Stablecoin mint and redeem price-delta checks should normalize decimals correctly, bound rounding and overflow, and enforce the intended loss and overpayment direction for each order type.",
    keywords: ["stable", "price", "decimals", "delta", "rounding"],
  });
  pushObligation(obligations, facts, "evm_block_limit", {
    id: "solidity-per-asset-global-block-limit",
    property:
      "Per-asset and global mint or redeem limits should measure the value that can leave or enter the protocol, not only a caller-selected nominal field that can diverge from actual settlement value.",
    keywords: ["block limit", "max mint", "max redeem", "asset limit", "global limit"],
  });
  pushObligation(obligations, facts, "evm_governance_payload", {
    id: "solidity-governance-payload-execution-boundary",
    property:
      "Governance payload execution should bind the approved payload address, codehash, selector, deadline, executability predicate, delegatecall context, and post-execution authority invariants.",
    keywords: ["governance payload", "spell", "codehash", "deadline", "delegatecall", "ward"],
  });
  pushObligation(obligations, facts, "evm_dao_governance", {
    id: "solidity-dao-vote-result-and-execution-integrity",
    property:
      "DAO proposal, voting, validator, delegation, NFT-power, quorum, reward, and execution paths should preserve one-person/one-token/one-NFT voting assumptions, prevent double counting or stale voting power, and execute only the action approved by the final governance result.",
    keywords: ["dao governance", "proposal", "vote", "quorum", "validator", "delegation", "execution"],
    priorityPathPattern: /\b(?:GovPool|GovValidators|GovUserKeeper|GovSettings|ERC721Expert|ERC721Multiplier)\b/i,
    priorityPattern: /\b(?:createProposal|executeProposal|moveProposalToValidators|vote|VoteType|votesFor|votesAgainst|quorum|validator|validators|GovUserKeeper|votingPower|rawPower|delegat|proposalState|ProposalState)\b/i,
  });
  pushObligation(obligations, facts, "evm_name_registry_resolution", {
    id: "solidity-name-registry-resolution-integrity",
    property:
      "Name-service registry, registrar, resolver, wrapper, fuse, expiry, reverse-record, DNSSEC import, and migration paths should preserve the intended owner/controller authority and resolution result for each name without allowing unauthorized name theft, freezing, fuse escalation, expiry shortening, resolver substitution, or metadata/content alteration.",
    keywords: [
      "ens",
      "name registry",
      "resolver",
      "registrar",
      "name wrapper",
      "fuses",
      "subname",
      "migration",
    ],
    priorityPathPattern: /\b(?:ENSRegistry|NameWrapper|BaseRegistrar|ETHRegistrar|ETHRegistrarController|PublicResolver|UniversalResolver|ReverseRegistrar|Registry|Registrar|Resolver|WrapperRegistry|PermissionedRegistry|PermissionedResolver|DNSTLDResolver|DNSRegistrar|MigrationController|WrapperReceiver)\b/i,
    priorityPattern: /\b(?:setSubnodeOwner|setSubnodeRecord|setRecord|setResolver|setOwner|register|renew|wrap|unwrap|setFuses|ownerOf|resolver|addr|contenthash|setNameForAddr|claimWithResolver|migrate|permissions|roles|expiry|expires|rentPrice|commitment)\b/i,
  });
  pushObligation(obligations, facts, "evm_validator_cluster_accounting", {
    id: "solidity-validator-cluster-fee-liquidation-conservation",
    property:
      "Validator-cluster accounting should settle operator and network fee indexes, validator counts, effective-balance or vUnits roots, DAO totals, operator earnings, cluster balances, migration, reactivation, withdrawal, and liquidation paths without allowing stale roots, rounding, removed operators, or mismatched snapshots to steal, freeze, overcharge, or prematurely liquidate funds.",
    keywords: [
      "validator cluster",
      "operator fee",
      "effective balance",
      "vUnits",
      "liquidation",
      "fee index",
      "root",
    ],
    priorityPathPattern: /\b(?:SSVClusters|SSVValidators|SSVOperators|SSVViews|ClusterLib|OperatorLib|ProtocolLib|SSVStorageEB)\b/i,
    priorityPattern: /\b(?:updateClusterBalance|registerValidator|removeValidator|migrateClusterToETH|reactivate|liquidate|withdraw|updateClusterOperators|updateDAOEthVUnits|operatorEthVUnits|effectiveBalance|vUnits|validatorCount|ethValidatorCount|currentNetworkFeeIndex)\b/i,
  });
  return obligations;
}

function pushObligation(
  out: ProofObligation[],
  facts: ProvenanceFact[],
  kind: ProvenanceFactKind,
  input: { id: string; property: string; keywords: string[]; priorityPattern?: RegExp; priorityPathPattern?: RegExp },
): void {
  const matchingFacts = facts.filter((fact) => fact.kind === kind);
  const sortedFacts = input.priorityPattern || input.priorityPathPattern
    ? [...matchingFacts].sort((left, right) => {
        const leftPriority = factPriority(left, input.priorityPattern, input.priorityPathPattern);
        const rightPriority = factPriority(right, input.priorityPattern, input.priorityPathPattern);
        return leftPriority - rightPriority;
      })
    : matchingFacts;
  const refs = sortedFacts.map((fact) => `${fact.path}:${fact.line}`).slice(0, 16);
  if (refs.length === 0) return;
  out.push({
    id: input.id,
    kind: "provenance",
    property: input.property,
    rationale:
      "This is a Solidity provenance obligation, not a finding: the model should enumerate a source-backed audit item only if the loaded code makes this edge security-relevant.",
    evidenceRefs: refs,
    keywords: input.keywords,
  });
}

function factPriority(fact: ProvenanceFact, pattern?: RegExp, pathPattern?: RegExp): number {
  let priority = 0;
  if (pathPattern && !pathPattern.test(fact.path)) priority += 2;
  if (pattern && !pattern.test(`${fact.sourceExpression ?? ""} ${fact.functionName ?? ""}`)) priority += 1;
  return priority;
}

function fact(input: {
  kind: ProvenanceFactKind;
  path: string;
  line: number;
  functionName?: string | undefined;
  label?: string | undefined;
  sourceExpression?: string | undefined;
  nearbySignals: string[];
  code: string;
}): ProvenanceFact {
  return {
    id: `${input.kind}-${slug(input.path)}-${input.line}`,
    domain: "solidity",
    kind: input.kind,
    path: input.path,
    line: input.line,
    ...(input.functionName ? { functionName: input.functionName } : {}),
    ...(input.label ? { label: input.label.trim() } : {}),
    ...(input.sourceExpression ? { sourceExpression: input.sourceExpression.trim() } : {}),
    nearbySignals: input.nearbySignals,
    code: input.code,
  };
}

function looksLikeSolidityDoc(doc: Doc): boolean {
  return doc.path.endsWith(".sol");
}

function looksLikeNameRegistryLine(code: string): boolean {
  const strongNameSignals =
    /\b(?:ENS|ENSRegistry|NameWrapper|INameWrapper|BaseRegistrar|ETHRegistrar|ETHRegistrarController|PublicResolver|UniversalResolver|ReverseRegistrar|WrapperRegistry|PermissionedRegistry|PermissionedResolver|DNSTLDResolver|DNSSEC|DNSRegistrar|MigrationController|WrapperReceiver|namehash|labelhash|subnode|subname|contenthash|setResolver|setContenthash|setSubnodeOwner|setSubnodeRecord|setNameForAddr|claimWithResolver|setFuses|CANNOT_UNWRAP|PARENT_CANNOT_CONTROL|reverseNode)\b/i;
  if (strongNameSignals.test(code)) return true;

  const weakTerms = [
    /\bresolver\b/i,
    /\bregistrar\b/i,
    /\bregister\b/i,
    /\brenew\b/i,
    /\bwrap\b/i,
    /\bunwrap\b/i,
    /\bfuses?\b/i,
    /\bexpiry\b/i,
    /\bexpires\b/i,
    /\brentPrice\b/i,
    /\bcommitment\b/i,
    /\bregistrant\b/i,
  ];
  return weakTerms.filter((term) => term.test(code)).length >= 2;
}

function looksLikeSelectorForwardingLine(code: string, nearbySignals: string[]): boolean {
  const context = nearbySignals.join(" ");
  const selectorPattern =
    /\b(?:msg\.sig|msg\.data|authFnCalls?|getAuthFunctionCallTarget|setAuthFunctionCall(?:Many)?|unsetAuthFunctionCall|_toFunctionSigHash|_convertToBytes4|abi\.encodeWithSignature|function selector|selector allowlist|selector whitelist)\b/i.test(
      code,
    ) || /\bmapping\s*\(\s*bytes4\s*=>\s*address\s*\)/i.test(code);
  const forwardingPattern =
    /\b(?:fallback\s*\(|functionCall\s*\(|Address\.functionCall|msg\.data|msg\.sig|getAuthFunctionCallTarget|authFnCalls?|setAuthFunctionCall(?:Many)?|unsetAuthFunctionCall)\b/i.test(
      code,
    ) || /\.(?:call|staticcall|delegatecall)\s*(?:\{|\.|\()/.test(code);
  const contextualSelector = /\b(?:selector|msg\.sig|msg\.data|auth function|allowlist)\b/i.test(context);
  const contextualForwarding = /\b(?:fallback|msg\.data|msg\.sig|auth function)\b/i.test(context);
  return (selectorPattern && (forwardingPattern || contextualForwarding)) || (forwardingPattern && contextualSelector);
}

function looksLikeRecurringAgreementLine(code: string, nearbySignals: string[]): boolean {
  if (/^(?:import\b|\/\*|\*|\/\/|\})/.test(code)) return false;
  if (/^[A-Z][A-Za-z0-9_]*,\s*$/.test(code)) return false;
  const context = nearbySignals.join(" ");
  const directPattern =
    /\b(?:RecurringCollectionAgreement(?:Update)?|IAgreementCollector|IAgreementOwner|AgreementData|AgreementState|CollectParams|StoredOffer|storedOffers?|rcaOffers|rcauOffers|cancelledOffers|activeTermsHash|updateNonce|lastCollectionAt|getMaxNextClaim|collectionStart|collectionEnd|minSecondsPerCollection|maxSecondsPerCollection|maxInitialTokens|maxOngoingTokensPerSecond|beforeCollection|afterCollection|OfferStored|OfferCancelled|AgreementAccepted|AgreementUpdated|AgreementCanceled|PaymentCollected|RCACollected)\b/.test(
      code,
    );
  const entrypointPattern = /\bfunction\s+(?:accept|update|offer|cancel|collect|getMaxNextClaim|getAgreementDetails|getAgreementOfferAt)\s*\(/.test(
    code,
  );
  const lifecyclePattern =
    /\b(?:isEligible|termsHash|versionHash|offerHash|agreementId|maxSlippage|collectionSeconds|tokensToCollect|collection window|max claim|_requireAuthorization|_requireValidCollect|_getMaxNextClaimScoped|_preCollectCallbacks|_postCollectCallback)\b/i.test(
      code,
    );
  const contextualAgreement = /\b(?:agreement|recurring|payer|max claim)\b/i.test(context);
  return directPattern || entrypointPattern || (lifecyclePattern && contextualAgreement);
}

function looksLikePaymentDistributionLine(code: string, nearbySignals: string[]): boolean {
  if (/^(?:import\b|\/\*|\*|\/\/|\})/.test(code)) return false;
  const context = nearbySignals.join(" ");
  const directPattern =
    /\b(?:GraphPaymentCollected|EscrowCollected|PaymentCollected|PROTOCOL_PAYMENT_CUT|dataServiceCut|receiverDestination|tokensProtocol|tokensDataService|tokensDelegationPool|tokensRemaining|escrowBalanceBefore|escrowBalanceAfter|PaymentsEscrowInconsistentCollection|mulPPMRoundUp|getDelegationFeeCut|addToDelegationPool|stakeTo|pushTokens|pullTokens|burnTokens)\b/.test(
      code,
    );
  const routePattern =
    /\b(?:paymentType|payer|collector|receiver|dataService|delegation pool|protocol cut|service cut|receiver destination|escrow balance|payment cut)\b/i.test(
      code,
    );
  const contextualPayment = /\b(?:payment|escrow|receiver|data service|delegation|collector)\b/i.test(context);
  return directPattern || (routePattern && contextualPayment);
}

function looksLikeStateWrite(code: string): boolean {
  if (!/[+\-*/%|&^]?=/.test(code)) return false;
  if (/^\s*\(/.test(code)) return false;
  if (/^\s*(?:u?int\d*|bool|address|string|bytes\d*|mapping|struct|enum)\b/.test(code)) return false;
  if (/^\s*[A-Z][A-Za-z0-9_]*(?:\[\])?\s+(?:memory|storage|calldata\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(code)) return false;
  if (/\b(require|assert|if|for|while|return|emit|revert)\b/.test(code)) return false;
  return /\b[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\]|\.[A-Za-z_][A-Za-z0-9_]*)?\s*[+\-*/%|&^]?=/.test(code);
}

function nearbySignalsFor(lines: string[], idx: number): string[] {
  const start = Math.max(0, idx - 6);
  const end = Math.min(lines.length, idx + 7);
  const text = lines.slice(start, end).join("\n").toLowerCase();
  return SIGNAL_TERMS.filter((term) => text.includes(term)).slice(0, 12);
}

function enclosingFunction(lines: string[], idx: number): string | undefined {
  for (let pos = idx; pos >= 0 && pos >= idx - 120; pos -= 1) {
    const line = stripInlineComment(lines[pos] ?? "").trim();
    if (line.length === 0 || /^(?:\/\*|\*|\/\/)/.test(line)) continue;
    const functionMatch = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (functionMatch?.[1]) return functionMatch[1];
    if (/\breceive\s*\(/.test(line)) return "receive";
    if (/\bfallback\s*\(/.test(line)) return "fallback";
    const contractMatch = /\b(?:contract|library|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    if (contractMatch?.[1]) return contractMatch[1];
  }
  return undefined;
}

function stripInlineComment(input: string): string {
  return input.replace(/\/\/.*$/, "");
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "fact";
}
