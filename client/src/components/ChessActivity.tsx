import { useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

type LocalMove = {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
};

export default function ChessActivity() {
  const [game, setGame] = useState(new Chess());

  function makeMove(move: LocalMove) {
    const gameCopy = new Chess(game.fen());
    const result = gameCopy.move(move);

    if (result) {
      setGame(gameCopy);
      return true;
    }

    return false;
  }

  function onDrop({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare?: string;
  }) {
    if (!targetSquare) return false;

    return makeMove({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });
  }

  return (
    <div style={{ width: 500 }}>
      <Chessboard
        options={{
          id: "BreakroomChessBoard",
          position: game.fen(),
          onPieceDrop: onDrop,
        }}
      />
    </div>
  );
}