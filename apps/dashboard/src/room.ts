import { useReducer } from "react";

import { initialState, reducer } from "./reducer";
import { useMockQueen } from "./useMockQueen";
import { useQueenSocket } from "./useQueenSocket";

// A build-time constant (replaced by Vite), so the mock is tree-shaken from production bundles.
const useRoomSocket = import.meta.env.VITE_MOCK_API === "1" ? useMockQueen : useQueenSocket;

/** The live link to one hive: reducer state plus the socket. Owned by the hive root so it survives page changes. */
export function useRoom(hive: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const link = useRoomSocket(hive, dispatch);
  return { state, dispatch, ...link };
}
export type Room = ReturnType<typeof useRoom>;
