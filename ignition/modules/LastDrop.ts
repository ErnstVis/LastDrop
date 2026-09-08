import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("LastDropModule", (m) => {
  const deployer = m.getAccount(0);

  // Шаг 1: токен, временный владелец — сам деплоер
  const token = m.contract("LastDropToken", [deployer]);

  // Шаг 2: игра, знает адрес токена сразу при деплое
  const lastDrop = m.contract("LastDrop", [token]);

  // Шаг 3: передаём права на минт игровому контракту
  m.call(token, "transferOwnership", [lastDrop]);

  return { token, lastDrop };
});