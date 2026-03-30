type C4Color = "r" | "y" | null;

type Props = {
  board: C4Color[][];
  turn: "r" | "y";
  winner: null | "r" | "y" | "draw";
  myColor: "r" | "y";
  onDrop: (col: number) => void;
  onRematch: () => void;
};

const COLOR: Record<string, string> = {
  r: "#e74c3c",
  y: "#f1c40f",
  null: "#ecf0f1",
};

const LABEL: Record<string, string> = {
  r: "Red",
  y: "Yellow",
};

export default function Connect4Activity({ board, turn, winner, myColor, onDrop, onRematch }: Props) {
  const myTurn = !winner && turn === myColor;

  return (
    <div style={{ userSelect: "none" }}>
      <p>
        You are: <b style={{ color: COLOR[myColor] }}>{LABEL[myColor]}</b>
      </p>

      {winner ? (
        <div style={{ marginBottom: 12, fontSize: 18, fontWeight: "bold" }}>
          {winner === "draw"
            ? "It's a draw!"
            : winner === myColor
            ? "🎉 You win!"
            : "😞 You lose!"}
          <button onClick={onRematch} style={{ marginLeft: 12 }}>
            Rematch
          </button>
        </div>
      ) : (
        <p style={{ fontWeight: "bold" }}>
          {myTurn
            ? `Your turn (${LABEL[myColor]})`
            : `Opponent's turn (${LABEL[turn]})...`}
        </p>
      )}

      {/* Column drop buttons */}
      <div style={{ display: "flex", marginBottom: 4 }}>
        {Array.from({ length: 7 }, (_, col) => (
          <button
            key={col}
            onClick={() => myTurn && onDrop(col)}
            disabled={!myTurn || !!winner}
            style={{
              width: 60,
              marginRight: 4,
              cursor: myTurn && !winner ? "pointer" : "default",
              fontSize: 18,
            }}
          >
            ↓
          </button>
        ))}
      </div>

      {/* Board */}
      <div
        style={{
          display: "inline-block",
          background: "#2980b9",
          padding: 8,
          borderRadius: 8,
        }}
      >
        {board.map((row, r) => (
          <div key={r} style={{ display: "flex" }}>
            {row.map((cell, c) => (
              <div
                key={c}
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: "50%",
                  background: cell ? COLOR[cell] : COLOR["null"],
                  margin: 4,
                  transition: "background 0.15s",
                  boxShadow: "inset 0 2px 6px rgba(0,0,0,0.3)",
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
