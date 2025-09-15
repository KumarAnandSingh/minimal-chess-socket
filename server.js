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
  res.json({ status: 'ok', message: 'Socket.IO server running' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('authenticate', (userData) => {
    console.log('User authenticated:', userData);
    socket.emit('authenticated', { success: true, playerInfo: userData });
  });

  socket.on('join_matchmaking', (options) => {
    console.log('Join matchmaking:', options);
    socket.emit('matchmaking_queued', { position: 1, timeControl: options.timeControl });

    // Simulate finding a game after 3 seconds
    setTimeout(() => {
      socket.emit('game_started', {
        gameId: 'demo-game-' + Date.now(),
        white: { username: 'You', rating: 1200 },
        black: { username: 'Opponent', rating: 1250 },
        timeControl: options.timeControl
      });
    }, 3000);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});