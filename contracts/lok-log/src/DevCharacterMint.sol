// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DevCharacterMint
/// @notice Local stand-in with the same mint surface as CharacterFactory + CharacterNFT.
///         createCharacter mints LOKC to msg.sender and charges an exact ETH fee.
///         Production deploys use CharacterFactory behind the proxy in Deploy.s.sol.
contract DevCharacterMint {
    string public constant name = "Legend of Kek Character";
    string public constant symbol = "LOKC";

    uint256 public mintFee;
    uint256 public nextTokenId;
    mapping(uint8 => bool) public isStartingJob;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    event CharacterCreated(address indexed player, uint256 indexed tokenId, uint8 startingJob);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    error WrongFee();
    error BadJob();

    constructor(uint256 mintFee_) {
        mintFee = mintFee_;
        for (uint8 job = 0; job < 7; job++) {
            isStartingJob[job] = true;
        }
    }

    function createCharacter(uint8 startingJob) external payable returns (uint256 tokenId) {
        if (msg.value != mintFee) revert WrongFee();
        if (!isStartingJob[startingJob]) revert BadJob();
        tokenId = ++nextTokenId;
        _owners[tokenId] = msg.sender;
        _balances[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, tokenId);
        emit CharacterCreated(msg.sender, tokenId, startingJob);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "invalid token");
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "zero address");
        return _balances[owner];
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x01ffc9a7;
    }
}
