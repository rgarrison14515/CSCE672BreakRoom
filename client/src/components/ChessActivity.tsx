import { Chessboard } from "react-chessboard";

type ChessActivityProps = {
  fen: string;
  playerColor: "w" | "b";
  turn: "w" | "b";
  onMove: (move: { from: string; to: string; promotion?: "q" | "r" | "b" | "n" }) => void;
};

export default function ChessActivity({ fen, playerColor, turn, onMove }: ChessActivityProps) {
  const myTurn = turn === playerColor;

  return (
    <div>
      <div className="game-status" style={{ marginBottom: 12 }}>
        <div
          className="turn-indicator"
          style={{ background: turn === "w" ? "#f0f0f0" : "#333" , border: "1px solid rgba(255,255,255,0.2)" }}
        />
        <span>
          {myTurn
            ? <><span className="glow">Your turn</span> — {playerColor === "w" ? "White" : "Black"}</>
            : <>Opponent's turn — {turn === "w" ? "White" : "Black"}</>}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
          You: <span style={{ color: "var(--text)", fontWeight: 700 }}>
            {playerColor === "w" ? "White ♙" : "Black ♟"}
          </span>
        </span>
      </div>

      <div style={{
        width: 480,
        borderRadius: 14,
        overflow: "hidden",
        border: "2px solid var(--border)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}>
        <Chessboard
          options={{
            position: fen,
            boardOrientation: playerColor === "w" ? "white" : "black",
            onPieceDrop: ({ sourceSquare, targetSquare }) => {
              if (!targetSquare) return false;
              onMove({ from: sourceSquare, to: targetSquare, promotion: "q" });
              return false;
            },
          }}
        />
      </div>
    </div>
  );
}
