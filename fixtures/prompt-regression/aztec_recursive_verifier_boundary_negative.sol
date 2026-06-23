// Minimized Solidity recursive-verifier negative control for prompt regression.
// Public-input limbs are range-checked, decoded as canonical base-field
// coordinates, and the recursive accumulator is combined on the intended sides.

pragma solidity ^0.8.20;

library CanonicalCurveFixture {
    uint256 internal constant SCALAR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant BASE_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant LIMB_BOUND = 1 << 68;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    function canonicalCoordinate(uint256[4] memory limbs) internal pure returns (uint256 value) {
        for (uint256 i = 0; i < 4; i++) {
            require(limbs[i] < LIMB_BOUND, "non-canonical limb");
            value |= limbs[i] << (68 * i);
        }
        require(value < BASE_MODULUS, "coordinate out of range");
    }

    function newCanonicalG1(uint256 x, uint256 y) internal pure returns (G1Point memory) {
        require(x < BASE_MODULUS && y < BASE_MODULUS, "non-canonical point");
        return G1Point(x, y);
    }

    function add(G1Point memory a, G1Point memory b) internal pure returns (G1Point memory) {
        return G1Point(addmod(a.x, b.x, BASE_MODULUS), addmod(a.y, b.y, BASE_MODULUS));
    }

    function scale(G1Point memory p, uint256 scalar) internal pure returns (G1Point memory) {
        return G1Point(mulmod(p.x, scalar, BASE_MODULUS), mulmod(p.y, scalar, BASE_MODULUS));
    }
}

contract RecursiveVerifierBoundaryControl {
    using CanonicalCurveFixture for CanonicalCurveFixture.G1Point;

    struct Proof {
        CanonicalCurveFixture.G1Point recursiveP1;
        CanonicalCurveFixture.G1Point recursiveP2;
    }

    function deserializeProof(uint256[] calldata publicInputs) public pure returns (Proof memory proof) {
        require(publicInputs.length >= 16, "missing recursive limbs");

        uint256[4] memory x0 = [publicInputs[0], publicInputs[1], publicInputs[2], publicInputs[3]];
        uint256[4] memory y0 = [publicInputs[4], publicInputs[5], publicInputs[6], publicInputs[7]];
        uint256[4] memory x1 = [publicInputs[8], publicInputs[9], publicInputs[10], publicInputs[11]];
        uint256[4] memory y1 = [publicInputs[12], publicInputs[13], publicInputs[14], publicInputs[15]];

        proof.recursiveP1 = CanonicalCurveFixture.newCanonicalG1(
            CanonicalCurveFixture.canonicalCoordinate(x0),
            CanonicalCurveFixture.canonicalCoordinate(y0)
        );
        proof.recursiveP2 = CanonicalCurveFixture.newCanonicalG1(
            CanonicalCurveFixture.canonicalCoordinate(x1),
            CanonicalCurveFixture.canonicalCoordinate(y1)
        );
    }

    function performPairing(Proof memory proof, CanonicalCurveFixture.G1Point memory lhs, CanonicalCurveFixture.G1Point memory rhs, uint256 separator)
        public
        pure
        returns (CanonicalCurveFixture.G1Point memory finalLhs, CanonicalCurveFixture.G1Point memory finalRhs)
    {
        uint256 u2 = mulmod(separator, separator, CanonicalCurveFixture.SCALAR_MODULUS);

        // Design intent: recursiveP1 contributes to the challenge-side
        // accumulator and recursiveP2 contributes to the unit-side accumulator.
        finalLhs = lhs.add(proof.recursiveP1.scale(u2));
        finalRhs = rhs.add(proof.recursiveP2.scale(u2));
    }
}
