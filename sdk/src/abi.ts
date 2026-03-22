// Minimal ABI — only the functions the SDK needs to call.
export const TASK_ESCROW_ABI = [
  {
    type: "function",
    name: "createTask",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "claimTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "submitResult",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "resultHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approveResult",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "expireTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "releaseClaim",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "releaseStaleClaimTask",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
