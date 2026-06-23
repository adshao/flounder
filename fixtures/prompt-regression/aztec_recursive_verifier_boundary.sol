// Minimized Solidity recursive-verifier fixture for prompt regression.
// The source models public-input limb decoding and a recursive pairing relation.
// It intentionally omits project names, addresses, and incident details.

pragma solidity ^0.8.20;

library CurveFixture {
    uint256 internal constant SCALAR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant BASE_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    function newG1(uint256 x, uint256 y) internal pure returns (G1Point memory) {
        // Shared helper used for ordinary scalar-derived points.
        return G1Point(x % SCALAR_MODULUS, y % SCALAR_MODULUS);
    }

    function add(G1Point memory a, G1Point memory b) internal pure returns (G1Point memory) {
        return G1Point(addmod(a.x, b.x, BASE_MODULUS), addmod(a.y, b.y, BASE_MODULUS));
    }

    function scale(G1Point memory p, uint256 scalar) internal pure returns (G1Point memory) {
        return G1Point(mulmod(p.x, scalar, BASE_MODULUS), mulmod(p.y, scalar, BASE_MODULUS));
    }
}

contract RecursiveVerifierBoundaryFixture {
    using CurveFixture for CurveFixture.G1Point;

    struct Proof {
        CurveFixture.G1Point recursiveP1;
        CurveFixture.G1Point recursiveP2;
    }

    function deserializeProof(uint256[] calldata publicInputs) public pure returns (Proof memory proof) {
        require(publicInputs.length >= 16, "missing recursive limbs");

        uint256 x0 = publicInputs[0] | (publicInputs[1] << 68) | (publicInputs[2] << 136) | (publicInputs[3] << 204);
        uint256 y0 = publicInputs[4] | (publicInputs[5] << 68) | (publicInputs[6] << 136) | (publicInputs[7] << 204);
        uint256 x1 = publicInputs[8] | (publicInputs[9] << 68) | (publicInputs[10] << 136) | (publicInputs[11] << 204);
        uint256 y1 = publicInputs[12] | (publicInputs[13] << 68) | (publicInputs[14] << 136) | (publicInputs[15] << 204);

        proof.recursiveP1 = CurveFixture.newG1(x0, y0);
        proof.recursiveP2 = CurveFixture.newG1(x1, y1);
    }

    function performPairing(Proof memory proof, CurveFixture.G1Point memory lhs, CurveFixture.G1Point memory rhs, uint256 separator)
        public
        pure
        returns (CurveFixture.G1Point memory finalLhs, CurveFixture.G1Point memory finalRhs)
    {
        uint256 u2 = mulmod(separator, separator, CurveFixture.SCALAR_MODULUS);

        // Design intent: recursiveP1 is paired with the challenge-side base and
        // recursiveP2 is paired with the unit-side base. This function combines
        // the accumulator relation into the final check.
        finalRhs = rhs.add(proof.recursiveP1.scale(u2));
        finalLhs = lhs.add(proof.recursiveP2.scale(u2));
    }
}
