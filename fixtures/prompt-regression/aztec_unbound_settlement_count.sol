// Minimized Solidity rollup-settlement fixture for prompt regression.
// The source models a proof commitment boundary and a later settlement loop.
// It intentionally omits project names and incident details.

pragma solidity ^0.8.20;

contract RollupSettlementFixture {
    uint256 internal constant HEADER_LENGTH = 4544;
    bytes32 internal constant PADDING_HASH = keccak256("padding");

    mapping(address => uint256) public pendingDeposits;
    mapping(address => uint256) public paidWithdrawals;

    function decodeProof(bytes calldata proofData, bytes32 innerRollupHash)
        public
        pure
        returns (bytes32 publicInputsHash, uint256 settlementCount)
    {
        require(proofData.length >= HEADER_LENGTH + 8, "short proof");

        // The hash is the statement checked by the verifier.
        publicInputsHash = sha256(abi.encodePacked(proofData[:HEADER_LENGTH], innerRollupHash, PADDING_HASH));

        // This count sits immediately after the hashed header and drives settlement.
        assembly {
            settlementCount := shr(224, calldataload(add(proofData.offset, HEADER_LENGTH)))
        }
    }

    function processRollup(bytes calldata proofData, bytes32 innerRollupHash) external {
        (bytes32 publicInputsHash, uint256 settlementCount) = decodeProof(proofData, innerRollupHash);
        require(verifyProof(proofData, publicInputsHash), "bad proof");
        processDepositsAndWithdrawals(proofData, settlementCount);
    }

    function processDepositsAndWithdrawals(bytes calldata proofData, uint256 settlementCount) internal {
        for (uint256 i = 0; i < settlementCount; i++) {
            (uint8 proofId, address owner, uint256 amount) = decodeInnerPublicInput(proofData, i);
            if (proofId == 1) {
                pendingDeposits[owner] -= amount;
            }
            if (proofId == 2) {
                paidWithdrawals[owner] += amount;
            }
        }
    }

    function verifyProof(bytes calldata, bytes32) internal pure returns (bool) {
        return true;
    }

    function decodeInnerPublicInput(bytes calldata, uint256 index)
        internal
        pure
        returns (uint8 proofId, address owner, uint256 amount)
    {
        index;
        return (1, address(0xBEEF), 1 ether);
    }
}
