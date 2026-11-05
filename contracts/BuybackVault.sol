// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IStakingDonate {
    function donate() external payable;
}

/// @title BuybackVault
/// @notice Резерв обеспечения DROP-токена. Пополняется долей прибыли проекта
///         (permissionless — любой может позвать fund()). Держатели токена
///         могут в любой момент сжечь DROP и получить пропорциональную долю
///         резерва — курс = reserveBalance / totalSupply(token), с виртуальным
///         оффсетом на случай, если totalSupply() стремится к нулю.
///
///         Резерв растёт только до целевого backing ratio (до 10 нативных монет на 1 DROP).
///         Излишек сверх лимита автоматически уходит в StakingRewards —
///         резерв никогда не блокирует и не проваливает входящий платёж.
contract BuybackVault is ReentrancyGuard {
    ERC20Burnable public immutable token;
    IStakingDonate public immutable stakingRewards;

    // Целевой backing ratio: 1 токен обеспечен не более чем NATIVE_PER_TOKEN_MAX
    // нативной валюты (в базовых единицах, 1e18 = 1 к 1).
    uint256 public constant NATIVE_PER_TOKEN_MAX = 10 ether; // 1 DROP обеспечен максимум 10 нативных монет

    // Виртуальный оффсет — защита от деления на ноль и от манипуляции курсом
    // на грани, когда totalSupply() приближается к нулю. Не существует физически.
    uint256 private constant VIRTUAL_OFFSET = 1000;

    uint256 public reserveBalance;

    event ReserveFunded(address indexed from, uint256 amount, uint256 overflowForwarded);
    event Redeemed(address indexed user, uint256 tokenAmount, uint256 nativeAmount);

    constructor(address tokenAddress, address stakingRewardsAddress) {
        token = ERC20Burnable(tokenAddress);
        stakingRewards = IStakingDonate(stakingRewardsAddress);
    }

    /// @notice Целевой максимум резерва при текущей эмиссии.
    function maxReserve() public view returns (uint256) {
        return (token.totalSupply() * NATIVE_PER_TOKEN_MAX) / 1 ether;
    }

    /// @notice Текущий курс выкупа: сколько нативной валюты даётся за 1 токен
    ///         (в базовых единицах 1e18), с учётом виртуального оффсета.
    function redemptionRate() public view returns (uint256) {
        return (reserveBalance * 1 ether) / (token.totalSupply() + VIRTUAL_OFFSET);
    }

    /// @notice Пополнить резерв. Permissionless — вызывает игра, любой желающий,
    ///         или сторонний контракт. Если резерв уже на целевом уровне (10 на токен),
    ///         излишек не блокируется и не ревертит платёж — уходит стейкерам.
    function fund() external payable nonReentrant {
        require(msg.value > 0, "BuybackVault: zero funding");

        uint256 cap = maxReserve();
        uint256 room = cap > reserveBalance ? cap - reserveBalance : 0;
        uint256 accepted = msg.value > room ? room : msg.value;
        uint256 overflow = msg.value - accepted;

        reserveBalance += accepted;

        if (overflow > 0) {
            // Резерв полон — направляем излишек на распределение стейкерам,
            // а не держим его без дела и не проваливаем входящую транзакцию.
            stakingRewards.donate{value: overflow}();
        }

        emit ReserveFunded(msg.sender, msg.value, overflow);
    }

    /// @notice Сжечь DROP и забрать пропорциональную долю резерва.
    function redeem(uint256 tokenAmount) external nonReentrant {
        require(tokenAmount > 0, "BuybackVault: zero amount");

        uint256 payout = (tokenAmount * redemptionRate()) / 1 ether;
        require(payout > 0, "BuybackVault: payout too small");
        require(payout <= reserveBalance, "BuybackVault: insufficient reserve");

        // Effects перед interactions: сначала списываем состояние, потом сжигаем и платим.
        reserveBalance -= payout;

        token.burnFrom(msg.sender, tokenAmount);

        (bool sent, ) = payable(msg.sender).call{value: payout}("");
        require(sent, "BuybackVault: payout failed");

        emit Redeemed(msg.sender, tokenAmount, payout);
    }

    receive() external payable {
        revert("BuybackVault: use fund()");
    }
}
