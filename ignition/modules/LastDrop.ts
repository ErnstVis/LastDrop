import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("LastDropModule", (m) => {
  // Один контракт: игра и токен DROP в одном лице
  const lastDrop = m.contract("LastDrop", []);

  return { lastDrop };
});
