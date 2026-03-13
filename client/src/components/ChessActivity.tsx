import { Chessboard } from "react-chessboard";

type ChessActivityProps = {
  fen: string;
  playerColor: "w" | "b";
  onMove: (move: {
    from: string;
    to: string;
    promotion?: "q" | "r" | "b" | "n";
  }) => void;
};

export default function ChessActivity({
  fen,
  playerColor,
  onMove,
}: ChessActivityProps) {
  return (
    <div style={{ width: 500 }}>
      <Chessboard
        options={{
          position: fen,
          boardOrientation: playerColor === "w" ? "white" : "black",
          onPieceDrop: ({ sourceSquare, targetSquare }) => {
            if (!targetSquare) return false;

            onMove({
              from: sourceSquare,
              to: targetSquare,
              promotion: "q",
            });

            return false;
          },
        }}
      />
    </div>
  );
}