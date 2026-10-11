// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ActRegistry
/// @notice Append-only registry of Diavgeia act commitments. One ADA maps to an
///         ordered list of versions; a later version must reference the hash of
///         the one before it. Nothing is ever overwritten.
contract ActRegistry {
    struct Anchor {
        bytes32 actHash;     // keccak256(canonical JSON of the act)
        bytes8 actType;      // e.g. "B.2.2"
        uint64 payerVat;     // organisation AFM
        uint64 payeeVat;     // sponsor AFM (0 if none)
        uint128 amountCents; // EUR cents, 0 if the act carries no amount
        uint32 issueDate;    // unix day (days since epoch)
        bytes32 prevAnchor;  // actHash of the previous version, 0x0 for the first
        bytes32 contractRef; // KIMDIS id (left-padded ASCII), 0x0 if none
        address signer;      // key that anchored it
        uint64 anchoredAt;   // block.timestamp
        bool voided;         // this version voids the act (e.g. "ΑΚΥΡΟ ΧΡΗΜΑΤΙΚΟ ΕΝΤΑΛΜΑ")
    }

    address public admin;

    /// signer key -> organisation VAT it may anchor for (0 = not a signer)
    mapping(address => uint64) public signerOrg;

    /// ADA -> ordered versions
    mapping(bytes32 => Anchor[]) private _versions;

    event SignerSet(address indexed signer, uint64 orgVat);
    event Anchored(bytes32 indexed ada, bytes32 actHash, uint32 version, address indexed signer, bool voided);

    error NotAdmin();
    error SignerNotOfPayer();
    error FirstVersionHasPrev();
    error PrevMustBeLatest();
    error NotAnchored();
    error AlreadyVoided();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin) {
        admin = _admin;
    }

    function setSigner(address signer, uint64 orgVat) external onlyAdmin {
        signerOrg[signer] = orgVat;
        emit SignerSet(signer, orgVat);
    }

    /// @notice Anchor a version of an act. `a.signer` and `a.anchoredAt` are
    ///         ignored and overwritten from the transaction context.
    function anchor(bytes32 ada, Anchor calldata a) external returns (uint32 version) {
        if (signerOrg[msg.sender] != a.payerVat || a.payerVat == 0) revert SignerNotOfPayer();

        Anchor[] storage v = _versions[ada];
        if (v.length == 0) {
            if (a.prevAnchor != bytes32(0)) revert FirstVersionHasPrev();
        } else {
            Anchor storage last = v[v.length - 1];
            if (a.prevAnchor != last.actHash) revert PrevMustBeLatest();
            if (last.voided) revert AlreadyVoided();
        }

        Anchor memory stored = a;
        stored.signer = msg.sender;
        stored.anchoredAt = uint64(block.timestamp);
        v.push(stored);

        version = uint32(v.length);
        emit Anchored(ada, a.actHash, version, msg.sender, a.voided);
    }

    function versionCount(bytes32 ada) external view returns (uint256) {
        return _versions[ada].length;
    }

    function versionAt(bytes32 ada, uint256 i) external view returns (Anchor memory) {
        return _versions[ada][i];
    }

    function latest(bytes32 ada) public view returns (Anchor memory) {
        Anchor[] storage v = _versions[ada];
        if (v.length == 0) revert NotAnchored();
        return v[v.length - 1];
    }

    function isAnchored(bytes32 ada) external view returns (bool) {
        return _versions[ada].length > 0;
    }

    /// @notice Pack a Diavgeia ADA (up to 32 UTF-8 bytes) into bytes32.
    function adaKey(string calldata ada) external pure returns (bytes32) {
        bytes memory b = bytes(ada);
        require(b.length <= 32, "ada too long");
        bytes32 out;
        assembly {
            out := mload(add(b, 32))
        }
        // zero the tail beyond b.length
        uint256 shift = (32 - b.length) * 8;
        return bytes32((uint256(out) >> shift) << shift);
    }
}
