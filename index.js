const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// Estrutura expandida das salas
const rooms = {};

// Cenários disponíveis
const scenarios = [
  {
    id: "volcano",
    name: "Vulcão Ardente",
    background: "#ff4444",
    groundY: 150,
  },
  { id: "farm", name: "Fazenda Maluca", background: "#44aa44", groundY: 180 },
  { id: "city", name: "Cidade Caótica", background: "#4444aa", groundY: 200 },
  {
    id: "space",
    name: "Estação Espacial",
    background: "#220033",
    groundY: 120,
  },
  { id: "jungle", name: "Selva Selvagem", background: "#228844", groundY: 160 },
];

io.on("connection", (socket) => {
  console.log("conn:", socket.id);

  // Criar sala (mantendo sua lógica original)
  socket.on("createRoom", ({ roomId, name }, cb) => {
    if (rooms[roomId]) return cb({ ok: false, error: "room_exists" });

    rooms[roomId] = {
      players: {},
      obstacles: [],
      projectiles: [],
      takenItems: new Set(),
      placedItems: new Set(),
      deadPlayers: new Set(),
      reachedFlagPlayers: new Set(),
      phase: "waiting",
      scenario: null,
      host: socket.id,
      roundNumber: 1,
      roundTimer: null,
      itemSelectionTimer: null,
    };

    socket.join(roomId);
    rooms[roomId].players[socket.id] = {
      id: socket.id,
      name,
      x: 0,
      y: 0,
      ready: false,
      character: "🐹",
      points: 0,
    };

    io.to(roomId).emit("roomUpdate", rooms[roomId]);
    cb({ ok: true });
  });

  // Entrar na sala (mantendo sua lógica original + melhorias)
  socket.on("joinRoom", ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ ok: false, error: "no_room" });

    socket.join(roomId);
    room.players[socket.id] = {
      id: socket.id,
      name,
      x: 0,
      y: 0,
      ready: false,
      character: "🐹",
      points: 0,
    };

    io.to(roomId).emit("roomUpdate", room);
    cb({ ok: true, room: room });
  });

  // Sair da sala (mantendo sua lógica original)
  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    delete room.players[socket.id];
    socket.leave(roomId);
    if (Object.keys(room.players).length === 0) delete rooms[roomId];
    else io.to(roomId).emit("roomUpdate", room);
  });

  // NOVAS FUNCIONALIDADES

  // Iniciar seleção de cenário
  socket.on("startScenarioSelection", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Apenas o host pode iniciar
    if (room.host !== socket.id) return;

    room.phase = "selecting";
    io.to(roomId).emit("scenarioSelection");
    console.log(`Seleção de cenário iniciada na sala ${roomId}`);
  });

  // Selecionar cenário
  socket.on("selectScenario", ({ roomId, scenario }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "selecting") return;

    room.scenario = scenario;
    room.phase = "building";
    room.obstacles = []; // limpar obstáculos anteriores

    io.to(roomId).emit("buildingPhase", { scenario });
    console.log(`Cenário selecionado: ${scenario.name} na sala ${roomId}`);
  });

  // Colocar obstáculo (melhorado)
  socket.on("placeObstacle", ({ roomId, obstacle }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ ok: false, error: "no_room" });
    if (room.phase !== "building")
      return cb && cb({ ok: false, error: "wrong_phase" });

    // Verificar se posição é válida (não muito próxima de outros obstáculos)
    const isValidPosition = !room.obstacles.some(
      (existing) =>
        Math.abs(existing.x - obstacle.x) < 50 &&
        Math.abs(existing.y - obstacle.y) < 50
    );

    // Verificar se não está muito próximo do chão
    const groundY = room.scenario?.groundY || 150;
    const screenHeight = 800; // assumindo altura padrão
    if (obstacle.y > screenHeight - groundY - 50) {
      return cb && cb({ ok: false, error: "too_close_to_ground" });
    }

    if (isValidPosition) {
      const newObs = {
        ...obstacle,
        id: Date.now() + "_" + socket.id,
        ownerId: socket.id,
      };
      room.obstacles.push(newObs);

      // Usar o novo evento específico para obstáculos
      io.to(roomId).emit("obstacleAdded", newObs);
      io.to(roomId).emit("obstaclesUpdate", room.obstacles); // manter compatibilidade

      cb && cb({ ok: true });
      console.log(`Obstáculo ${obstacle.type} adicionado na sala ${roomId}`);
    } else {
      cb && cb({ ok: false, error: "invalid_position" });
    }
  });

  // Remover obstáculo
  socket.on("removeObstacle", ({ roomId, obstacleId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "building") return;

    const obstacleIndex = room.obstacles.findIndex(
      (obs) => obs.id === obstacleId && obs.ownerId === socket.id
    );

    if (obstacleIndex !== -1) {
      room.obstacles.splice(obstacleIndex, 1);
      io.to(roomId).emit("obstacleRemoved", { obstacleId });
      io.to(roomId).emit("obstaclesUpdate", room.obstacles);
    }
  });

  // Atualização de jogador (mantendo sua lógica + melhorias)
  socket.on("playerUpdate", ({ roomId, x, y }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.players[socket.id]) {
      room.players[socket.id].x = x;
      room.players[socket.id].y = y;

      // Emitir com dados completos do jogador
      const playerData = {
        id: socket.id,
        name: room.players[socket.id].name,
        x,
        y,
        character: room.players[socket.id].character,
      };

      socket.to(roomId).emit("playerMoved", playerData);
    }
  });

  // Iniciar round
  socket.on("startRound", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "building") return;

    // Apenas o host pode iniciar
    if (room.host !== socket.id) return;

    room.phase = "itemSelection";
    room.takenItems = new Set();
    room.placedItems = new Set();
    room.deadPlayers = new Set();
    room.reachedFlagPlayers = new Set();
    room.projectiles = [];

    // Reset posições dos jogadores para o chão
    const groundY = room.scenario?.groundY || 150;
    const screenHeight = 800;
    const screenWidth = 400;

    Object.values(room.players).forEach((player, index) => {
      player.x =
        (screenWidth / (Object.keys(room.players).length + 1)) * (index + 1);
      player.y = screenHeight - groundY - 50; // um pouco acima do chão
    });

    console.log(
      `Emitindo roundStarted para a sala ${roomId} com ${
        Object.keys(room.players).length
      } jogadores`
    );
    io.to(roomId).emit("roundStarted", {
      obstacles: room.obstacles,
      scenario: room.scenario,
      players: room.players,
    });

    console.log(
      `Round iniciado na sala ${roomId} com ${room.obstacles.length} obstáculos`
    );

    // Start projectile simulation
    setInterval(() => updateProjectiles(roomId), 100);
  });

  // Selecionar item
  socket.on("selectItem", ({ roomId, itemType }, cb) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "itemSelection") return cb({ ok: false });

    if (room.takenItems.has(itemType)) return cb({ ok: false });

    room.takenItems.add(itemType);
    io.to(roomId).emit("itemTaken", { itemType });
    cb({ ok: true });
  });

  // Item colocado
  socket.on("itemPlaced", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "itemSelection") return;

    room.placedItems.add(socket.id);
    if (room.placedItems.size === Object.keys(room.players).length) {
      room.phase = "playing";
      io.to(roomId).emit("startPlaying");
      startRoundTimer(roomId);
    }
  });

  // Skip item selection
  socket.on("skipItemSelection", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "itemSelection") return;

    room.placedItems.add(socket.id);
    if (room.placedItems.size === Object.keys(room.players).length) {
      room.phase = "playing";
      io.to(roomId).emit("startPlaying");
      startRoundTimer(roomId);
    }
  });

  // Player died
  socket.on("playerDied", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "playing") return;

    room.deadPlayers.add(socket.id);
    checkRoundEnd(roomId);
  });

  // Reached flag
  socket.on("reachedFlag", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "playing") return;

    room.reachedFlagPlayers.add(socket.id);
    checkRoundEnd(roomId);
  });

  // Verificar colisões
  socket.on("checkCollision", ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "playing") return;

    const player = room.players[playerId || socket.id];
    if (!player) return;

    // Verificar colisão com obstáculos
    const collision = room.obstacles.find(
      (obstacle) =>
        player.x < obstacle.x + obstacle.width &&
        player.x + 30 > obstacle.x &&
        player.y < obstacle.y + obstacle.height &&
        player.y + 30 > obstacle.y
    );

    if (collision) {
      // Emitir evento de colisão com efeito baseado no tipo
      const effects = {
        spike: { type: "damage", value: 1 },
        spring: { type: "bounce", value: 50 },
        hammer: { type: "knock", direction: "random" },
        saw: { type: "damage", value: 2 },
        cannon: { type: "explosion", radius: 100 },
        platform: { type: "none" },
      };

      socket.emit("collision", {
        obstacleType: collision.type,
        effect: effects[collision.type] || { type: "none" },
      });

      console.log(`Colisão: ${player.name} com ${collision.type}`);
    }
  });

  // Alterar personagem
  socket.on("changeCharacter", ({ roomId, character }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;

    room.players[socket.id].character = character;
    io.to(roomId).emit("playerCharacterChanged", {
      playerId: socket.id,
      character: character,
    });
  });

  // Estado da sala
  socket.on("getRoomState", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    socket.emit("roomState", {
      players: room.players,
      obstacles: room.obstacles,
      scenario: room.scenario,
      phase: room.phase,
      host: room.host,
    });
  });

  // Resetar sala
  socket.on("resetRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Apenas o host pode resetar
    if (room.host !== socket.id) return;

    room.obstacles = [];
    room.scenario = null;
    room.phase = "waiting";

    // Reset ready status
    Object.values(room.players).forEach((player) => {
      player.ready = false;
      player.x = 0;
      player.y = 0;
    });

    io.to(roomId).emit("roomReset");
    io.to(roomId).emit("roomUpdate", room);
    console.log(`Sala ${roomId} resetada`);
  });

  // Obter cenários disponíveis
  socket.on("getScenarios", () => {
    socket.emit("scenarioList", scenarios);
  });

  // Desconexão (melhorado)
  socket.on("disconnect", () => {
    console.log("dc:", socket.id);
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        // Se era o host, transferir para outro jogador
        if (room.host === socket.id) {
          const remainingPlayers = Object.keys(room.players);
          if (remainingPlayers.length > 0) {
            room.host = remainingPlayers[0];
            io.to(roomId).emit("newHost", { hostId: room.host });
          }
        }

        io.to(roomId).emit("roomUpdate", room);
        io.to(roomId).emit("playerLeft", { id: socket.id });

        if (Object.keys(room.players).length === 0) {
          delete rooms[roomId];
          console.log(`Sala ${roomId} removida (vazia)`);
        }
      }
    }
  });
});

app.get("/", (req, res) => res.send("Capybara Chaos server running"));

// Endpoint para estatísticas
app.get("/stats", (req, res) => {
  const stats = {
    totalRooms: Object.keys(rooms).length,
    totalPlayers: Object.values(rooms).reduce(
      (acc, room) => acc + Object.keys(room.players).length,
      0
    ),
    rooms: Object.entries(rooms).map(([id, room]) => ({
      id,
      playerCount: Object.keys(room.players).length,
      phase: room.phase,
      scenario: room.scenario?.name || "Nenhum",
      obstacleCount: room.obstacles.length,
    })),
  };
  res.json(stats);
});

function startRoundTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.roundTimer = setTimeout(() => {
    endRound(roomId);
  }, 120000); // 2 minutes
}

function checkRoundEnd(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const totalPlayers = Object.keys(room.players).length;
  const inactivePlayers = room.deadPlayers.size + room.reachedFlagPlayers.size;
  if (inactivePlayers >= totalPlayers) {
    endRound(roomId);
  }
}

function endRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== "playing") return;

  clearTimeout(room.roundTimer);

  const arrivalOrder = Array.from(room.reachedFlagPlayers).sort((a, b) => {
    // Assuming we track arrival time, but for simplicity, random order
    return Math.random() - 0.5;
  });

  const newPoints = {};
  arrivalOrder.forEach((id, index) => {
    newPoints[id] = 10 - index; // First gets 10, second 9, etc.
  });

  Object.keys(room.players).forEach((id) => {
    if (!newPoints[id]) newPoints[id] = 0;
  });

  io.to(roomId).emit("roundEnd", { newPoints });

  // Update points
  for (const id in newPoints) {
    room.players[id].points = (room.players[id].points || 0) + newPoints[id];
    if (room.players[id].points >= 50) {
      io.to(roomId).emit("gameWinner", { winnerId: id });
      return;
    }
  }

  if (room.roundNumber >= 5) {
    // Find winner with max points
    let maxPoints = 0;
    let winnerId = null;
    for (const id in room.players) {
      if (room.players[id].points > maxPoints) {
        maxPoints = room.players[id].points;
        winnerId = id;
      }
    }
    io.to(roomId).emit("gameWinner", { winnerId });
    return;
  }

  // Next round
  room.roundNumber++;
  room.phase = "itemSelection";
  room.takenItems = new Set();
  room.placedItems = new Set();
  room.deadPlayers = new Set();
  room.reachedFlagPlayers = new Set();
  // Reset positions if needed
}

function updateProjectiles(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== "playing") return;

  room.projectiles = room.projectiles
    .map((proj) => ({
      ...proj,
      x: proj.x + proj.dir * 5, // Move arrow
    }))
    .filter((proj) => proj.x > 0 && proj.x < 2000); // Remove off-screen

  // Spawn new arrows from crossbows
  room.obstacles.forEach((obs) => {
    if (obs.type === "crossbow" && Math.random() < 0.1) {
      // 10% chance per tick
      room.projectiles.push({
        id: Date.now() + "_" + Math.random(),
        x: obs.x + obs.width / 2,
        y: obs.y + obs.height / 2,
        width: 20,
        height: 5,
        dir: Math.random() > 0.5 ? 1 : -1,
        type: "arrow",
      });
    }
  });

  io.to(roomId).emit("projectilesUpdate", room.projectiles);
}

server.listen(PORT, () => console.log("listening on", PORT));
