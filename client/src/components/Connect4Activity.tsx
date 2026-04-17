type C4Color = "r" | "y" | null;

type Props = {
  board: C4Color[][];
  turn: "r" | "y";
  winner: null | "r" | "y" | "draw";
  myColor: "r" | "y";
  onDrop: (col: number) => void;
  onRematch: () => void;
};

const LABEL: Record<string, string> = { r: "Red", y: "Yellow" };

export default function Connect4Activity({ board, turn, winner, myColor, onDrop, onRematch }: Props) {
  const myTurn = !winner && turn === myColor;
  const oppColor = myColor === "r" ? "y" : "r";

  return (
    <div className="c4-wrapper">
      {/* Status bar */}
      <div className="game-status" style={{ marginBottom: 12 }}>
        {winner ? null : (
          <>
            <div
              className="turn-indicator"
              style={{ background: turn === "r" ? "var(--red)" : "var(--yellow)" }}
            />
            <span>
              {myTurn
                ? <><span className="glow">Your turn</span> — {LABEL[myColor]}</>
                : <>Opponent's turn — {LABEL[oppColor]}</>}
            </span>
          </>
        )}
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
          You: <span style={{ color: myColor === "r" ? "var(--red)" : "var(--yellow)", fontWeight: 700 }}>
            {LABEL[myColor]}
          </span>
        </span>
      </div>

      {/* Result banner */}
      {winner && (
        <div className={`c4-result ${winner === "draw" ? "draw" : winner === myColor ? "win" : "lose"}`}>
          {winner === "draw" ? "🤝 It's a draw!" : winner === myColor ? "🎉 You win!" : "😞 You lose!"}
          <button className="btn-ghost btn-sm" onClick={onRematch} style={{ marginLeft: 16 }}>
            Rematch
          </button>
        </div>
      )}

      {/* Drop buttons */}
      <div className="c4-drop-row">
        {Array.from({ length: 7 }, (_, col) => (
          <button
            key={col}
            className="c4-drop-btn"
            onClick={() => myTurn && onDrop(col)}
            disabled={!myTurn || !!winner}
            title={`Drop in column ${col + 1}`}
          >
            ▼
          </button>
        ))}
      </div>

      {/* Board */}
      <div className="c4-board">
        {board.map((row, r) => (
          <div key={r} className="c4-row">
            {row.map((cell, c) => (
              <div
                key={c}
                className={`c4-cell ${cell === "r" ? "red" : cell === "y" ? "yellow" : "empty"}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
