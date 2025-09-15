const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Real Multiplayer Chess Socket.IO Server' });
});

// Game state management
const waitingPlayers = new Map(); // timeControl -> [players]
const activeGames = new Map(); // gameId -> gameData
const playerSockets = new Map(); // socketId -> playerData

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('authenticate', (userData) => {
    console.log('Player authenticated:', userData);
    playerSockets.set(socket.id, {
      ...userData,
      socketId: socket.id,
      status: 'online'
    });
    socket.emit('authenticated', { success: true, playerInfo: userData });
  });

  socket.on('join_matchmaking', (options) => {
    const player = playerSockets.get(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Please authenticate first' });
      return;
    }

    const timeControlKey = `${options.timeControl.initial}+${options.timeControl.increment}`;
    console.log(`Player ${player.username} joining matchmaking for ${timeControlKey}`);

    // Initialize waiting queue for this time control
    if (!waitingPlayers.has(timeControlKey)) {
      waitingPlayers.set(timeControlKey, []);
    }

    const waitingQueue = waitingPlayers.get(timeControlKey);

    // Check if there's already a player waiting
    if (waitingQueue.length > 0) {
      // Match found! Create game
      const opponent = waitingQueue.shift();
      const gameId = 'game-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

      // Randomly assign colors
      const whitePlayer = Math.random() > 0.5 ? player : opponent;
      const blackPlayer = whitePlayer === player ? opponent : player;

      const gameData = {
        id: gameId,
        white: whitePlayer,
        black: blackPlayer,
        timeControl: options.timeControl,
        position: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // Starting position
        moves: [],
        turn: 'white',
        status: 'active',
        whiteTime: options.timeControl.initial * 1000, // Convert to milliseconds
        blackTime: options.timeControl.initial * 1000,
        startTime: Date.now()
      };

      activeGames.set(gameId, gameData);

      // Notify both players
      io.to(whitePlayer.socketId).emit('game_started', {
        gameId,
        color: 'white',
        opponent: blackPlayer,
        timeControl: options.timeControl,
        position: gameData.position
      });

      io.to(blackPlayer.socketId).emit('game_started', {
        gameId,
        color: 'black',
        opponent: whitePlayer,
        timeControl: options.timeControl,
        position: gameData.position
      });

      console.log(`Game started: ${whitePlayer.username} (white) vs ${blackPlayer.username} (black)`);
    } else {
      // No opponent found, add to waiting queue
      waitingQueue.push(player);
      socket.emit('matchmaking_queued', {
        position: waitingQueue.length,
        timeControl: options.timeControl,
        message: 'Searching for opponent...'
      });
      console.log(`Player ${player.username} added to queue, position: ${waitingQueue.length}`);
    }
  });

  socket.on('make_move', (data) => {
    const { gameId, move, timeLeft } = data;
    const game = activeGames.get(gameId);
    const player = playerSockets.get(socket.id);

    if (!game || !player) return;

    // Validate it's the player's turn
    const isWhite = game.white.socketId === socket.id;
    const isBlack = game.black.socketId === socket.id;

    if ((game.turn === 'white' && !isWhite) || (game.turn === 'black' && !isBlack)) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    // Update game state
    game.moves.push(move);
    game.turn = game.turn === 'white' ? 'black' : 'white';

    // Update time
    if (isWhite) {
      game.whiteTime = timeLeft;
    } else {
      game.blackTime = timeLeft;
    }

    // Broadcast move to both players
    io.to(game.white.socketId).emit('move_made', {
      gameId,
      move,
      turn: game.turn,
      whiteTime: game.whiteTime,
      blackTime: game.blackTime
    });

    io.to(game.black.socketId).emit('move_made', {
      gameId,
      move,
      turn: game.turn,
      whiteTime: game.whiteTime,
      blackTime: game.blackTime
    });

    console.log(`Move made in game ${gameId}: ${move.from}-${move.to}`);
  });

  socket.on('resign_game', (data) => {
    const { gameId } = data;
    const game = activeGames.get(gameId);
    if (!game) return;

    const isWhite = game.white.socketId === socket.id;
    const winner = isWhite ? 'black' : 'white';

    game.status = 'finished';
    game.result = isWhite ? '0-1' : '1-0';
    game.winner = winner;

    // Notify both players
    io.to(game.white.socketId).emit('game_ended', {
      gameId,
      result: game.result,
      winner,
      reason: 'resignation'
    });

    io.to(game.black.socketId).emit('game_ended', {
      gameId,
      result: game.result,
      winner,
      reason: 'resignation'
    });

    activeGames.delete(gameId);
    console.log(`Game ${gameId} ended by resignation`);
  });

  socket.on('leave_matchmaking', () => {
    const player = playerSockets.get(socket.id);
    if (!player) return;

    // Remove from all waiting queues
    for (const [timeControl, queue] of waitingPlayers.entries()) {
      const index = queue.findIndex(p => p.socketId === socket.id);
      if (index !== -1) {
        queue.splice(index, 1);
        console.log(`Player ${player.username} left matchmaking for ${timeControl}`);
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    const player = playerSockets.get(socket.id);
    console.log('Player disconnected:', socket.id, player?.username || 'Unknown');

    if (player) {
      // Remove from waiting queues
      for (const queue of waitingPlayers.values()) {
        const index = queue.findIndex(p => p.socketId === socket.id);
        if (index !== -1) {
          queue.splice(index, 1);
        }
      }

      // Handle active games
      for (const [gameId, game] of activeGames.entries()) {
        if (game.white.socketId === socket.id || game.black.socketId === socket.id) {
          const opponent = game.white.socketId === socket.id ? game.black : game.white;

          io.to(opponent.socketId).emit('opponent_disconnected', {
            gameId,
            message: 'Your opponent has disconnected'
          });

          activeGames.delete(gameId);
          console.log(`Game ${gameId} ended due to disconnection`);
        }
      }

      playerSockets.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Real Multiplayer Chess Server running on port ${PORT}`);
});