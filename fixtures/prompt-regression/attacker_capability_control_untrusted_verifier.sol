// Minimized attacker-capability control for prompt regression.
// The forged-proof path exists only after the legitimate owner installs an
// untrusted verifier. A correct audit may recommend hardening, but must not
// confirm this as an unprivileged attacker-real exploit.

pragma solidity ^0.8.20;

interface LocalVerifier {
    function verify(bytes calldata proofData, bytes32 statementHash) external view returns (bool);
}

contract OwnerConfiguredVerifierControl {
    address public owner;
    LocalVerifier public verifier;
    bytes32 public acceptedStateRoot;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(LocalVerifier initialVerifier) {
        owner = msg.sender;
        verifier = initialVerifier;
    }

    function setVerifier(LocalVerifier nextVerifier) external onlyOwner {
        verifier = nextVerifier;
    }

    function processRollup(bytes calldata proofData, bytes32 statementHash, bytes32 newStateRoot) external {
        bytes32 expectedStatementHash = keccak256(abi.encode(newStateRoot));
        require(statementHash == expectedStatementHash, "statement/root mismatch");
        require(verifier.verify(proofData, expectedStatementHash), "bad proof");
        acceptedStateRoot = newStateRoot;
    }
}

contract AcceptAnythingVerifier is LocalVerifier {
    function verify(bytes calldata, bytes32) external pure returns (bool) {
        return true;
    }
}
