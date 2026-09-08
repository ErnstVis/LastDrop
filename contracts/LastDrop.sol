// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./LastDropToken.sol";

contract LastDrop {
    address public owner;
    LastDropToken public token;

    uint256 public betAmount = 10 ether;
    uint256 public betInterval = 300;
    address public lastBettor = address(0);
    uint256 public bank = 0;
    uint256 public fee = 0;
    uint256 public deadline = block.timestamp;

    uint256 public constant BONUS_AMOUNT = 1 ether;      // 1 токен (18 decimals)
    uint256 public constant BANK_THRESHOLD = 1000 ether; // порог банка для бонуса

    mapping(address => uint256) public pendingWithdrawals;

    event BetPlaced(address indexed bettor, uint256 deadline);
    event BankClaimed(address indexed winner, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event ParamsUpdated(uint256 betAmount, uint256 betInterval);
    event BonusMinted(address indexed player, uint256 amount);   // ← новое

    modifier onlyOwner() {
        require(msg.sender == owner, "LastDrop: not owner");
        _;
    }

    constructor(address tokenAddress) {
        owner = msg.sender;
        token = LastDropToken(tokenAddress);
    }

    function bet() external payable {
        require(msg.value == betAmount, "LastDrop: wrong bet amount");

        if (deadline < block.timestamp && bank > 0) {
            address winner = lastBettor;
            uint256 payout = bank;

            bank = 0;
            pendingWithdrawals[winner] += payout;

            emit BankClaimed(winner, payout);
        }

        uint256 currentFee = msg.value / 10;
        fee += currentFee;
        bank += msg.value - currentFee;
        lastBettor = msg.sender;
        deadline = block.timestamp + betInterval;

        if (bank < BANK_THRESHOLD) {
            token.mint(msg.sender, BONUS_AMOUNT);
            emit BonusMinted(msg.sender, BONUS_AMOUNT);
        }

        emit BetPlaced(msg.sender, deadline);
    }

    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "LastDrop: nothing to withdraw");

        pendingWithdrawals[msg.sender] = 0;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "LastDrop: withdraw failed");

        emit Withdrawn(msg.sender, amount);
    }

    function withdrawFee() external onlyOwner {
        uint256 amount = fee;
        require(amount > 0, "LastDrop: nothing to withdraw");

        fee = 0;

        (bool sent, ) = payable(owner).call{value: amount}("");
        require(sent, "LastDrop: fee withdraw failed");

        emit Withdrawn(owner, amount);
    }

    function setBetAmount(uint256 _betAmount) external onlyOwner {
        betAmount = _betAmount;
        emit ParamsUpdated(betAmount, betInterval);
    }

    function setBetInterval(uint256 _betInterval) external onlyOwner {
        betInterval = _betInterval;
        emit ParamsUpdated(betAmount, betInterval);
    }
}