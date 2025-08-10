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
  console.log("🔌 Conexão estabelecida:", socket.id);

  // Criar sala
  socket.on("createRoom", ({ roomId, name }, cb) => {
    console.log(`🏠 Criando sala: ${roomId} por ${name}`);

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

    console.log(`✅ Sala ${roomId} criada. Host: ${socket.id}`);

    // SEMPRE enviar roomUpdate após qualquer mudança
    io.to(roomId).emit("roomUpdate", {
      ...rooms[roomId],
      players: rooms[roomId].players,
      phase: rooms[roomId].phase,
    });

    cb({ ok: true });
  });
  socket.on("requestRoomUpdate", ({ roomId }, cb) => {
    console.log(
      `📡 Jogador ${socket.id} solicitou atualização da sala ${roomId}`
    );
    const room = rooms[roomId];
    if (!room) {
      console.log(`❌ Sala ${roomId} não encontrada`);
      return cb({ ok: false, error: "no_room" });
    }

    cb({
      ok: true,
      room: {
        ...room,
        players: room.players,
        phase: room.phase,
        scenario: room.scenario,
        obstacles: room.obstacles,
        host: room.host,
      },
    });
  });
  // Entrar na sala
  socket.on("joinRoom", ({ roomId, name }, cb) => {
    console.log(
      `🚪 Jogador ${name} tentando entrar na sala ${roomId} com socket ${socket.id}`
    );
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

    console.log(
      `✅ Jogador ${name} entrou na sala ${roomId}. Total jogadores: ${
        Object.keys(room.players).length
      }`
    );
    io.in(roomId)
      .allSockets()
      .then((sockets) => {
        console.log(
          `📡 Sockets na sala ${roomId} após join:`,
          Array.from(sockets)
        );
      });

    io.to(roomId).emit("roomUpdate", {
      ...room,
      players: room.players,
      phase: room.phase,
    });

    cb({ ok: true, room });
  });

  // Sair da sala
  socket.on("leaveRoom", ({ roomId }) => {
    console.log(`🚪 Jogador saindo da sala: ${roomId}`);
    const room = rooms[roomId];
    if (!room) return;

    delete room.players[socket.id];
    socket.leave(roomId);

    if (Object.keys(room.players).length === 0) {
      delete rooms[roomId];
      console.log(`🗑️ Sala ${roomId} removida (vazia)`);
    } else {
      // Se era o host, transferir para outro jogador
      if (room.host === socket.id) {
        const remainingPlayers = Object.keys(room.players);
        if (remainingPlayers.length > 0) {
          room.host = remainingPlayers[0];
          console.log(`👑 Novo host da sala ${roomId}: ${room.host}`);
        }
      }

      io.to(roomId).emit("roomUpdate", {
        ...room,
        players: room.players,
        phase: room.phase,
      });
    }
  });

  // Iniciar seleção de cenário
  socket.on("startScenarioSelection", ({ roomId }) => {
    console.log(
      `🎯 Iniciando seleção de cenário na sala ${roomId} por ${socket.id}`
    );
    const room = rooms[roomId];
    if (!room) return;

    // Apenas o host pode iniciar
    if (room.host !== socket.id) {
      console.log(
        `❌ Tentativa negada: ${socket.id} não é o host (${room.host})`
      );
      return;
    }

    room.phase = "selecting";

    // Emitir AMBOS os eventos para garantir compatibilidade
    io.to(roomId).emit("scenarioSelection");
    io.to(roomId).emit("roomUpdate", {
      ...room,
      players: room.players,
      phase: room.phase,
    });

    console.log(`✅ Seleção de cenário iniciada na sala ${roomId}`);
  });

  // Selecionar cenário
  socket.on("selectScenario", ({ roomId, scenario }) => {
    console.log(
      `🌍 Cenário selecionado: ${scenario.name} na sala ${roomId} por ${socket.id}`
    );
    const room = rooms[roomId];
    if (!room || room.phase !== "selecting") return;

    room.scenario = scenario;
    room.phase = "building";
    room.obstacles = [];

    console.log(`🏠 Atualizando sala ${roomId} para fase building`);
    io.to(roomId).emit("buildingPhase", { scenario });
    io.to(roomId).emit("roomUpdate", {
      ...room,
      players: room.players,
      phase: room.phase,
      scenario: room.scenario,
    });
  });

  // Iniciar round (ESTE É O EVENTO CHAVE QUE ESTAVA FALTANDO SINCRONIZAÇÃO)
  socket.on("startRound", ({ roomId }) => {
    console.log(`🚀 Iniciando round na sala ${roomId} por ${socket.id}`);
    const room = rooms[roomId];
    if (!room || room.phase !== "building") return;

    if (room.host !== socket.id) {
      console.log(
        `❌ Tentativa negada: ${socket.id} não é o host (${room.host})`
      );
      return;
    }

    room.phase = "itemSelection";
    room.takenItems = new Set();
    room.placedItems = new Set();
    room.deadPlayers = new Set();
    room.reachedFlagPlayers = new Set();
    room.projectiles = [];

    const groundY = room.scenario?.groundY || 150;
    const screenHeight = 800;
    const screenWidth = 400;

    Object.values(room.players).forEach((player, index) => {
      player.x =
        (screenWidth / (Object.keys(room.players).length + 1)) * (index + 1);
      player.y = screenHeight - groundY - 50;
    });

    console.log(
      `📤 Enviando roundStarted para sala ${roomId} com ${
        Object.keys(room.players).length
      } jogadores`
    );
    // Log para verificar sockets na sala
    io.in(roomId)
      .allSockets()
      .then((sockets) => {
        console.log(`📡 Sockets na sala ${roomId}:`, Array.from(sockets));
      });

    io.to(roomId).emit("roundStarted", {
      obstacles: room.obstacles,
      scenario: room.scenario,
      players: room.players,
    });

    io.to(roomId).emit("roomUpdate", {
      ...room,
      players: room.players,
      phase: room.phase,
    });

    console.log(
      `✅ Round iniciado na sala ${roomId} com ${room.obstacles.length} obstáculos`
    );

    setInterval(() => updateProjectiles(roomId), 100);
  });

  // Colocar obstáculo
  socket.on("placeObstacle", ({ roomId, obstacle }, cb) => {
    console.log(`🔧 Colocando obstáculo ${obstacle.type} na sala ${roomId}`);
    const room = rooms[roomId];
    if (!room) return cb && cb({ ok: false, error: "no_room" });
    if (room.phase !== "building")
      return cb && cb({ ok: false, error: "wrong_phase" });

    // Verificações de posição
    const isValidPosition = !room.obstacles.some(
      (existing) =>
        Math.abs(existing.x - obstacle.x) < 50 &&
        Math.abs(existing.y - obstacle.y) < 50
    );

    const groundY = room.scenario?.groundY || 150;
    const screenHeight = 800;
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

      io.to(roomId).emit("obstacleAdded", newObs);
      cb && cb({ ok: true });
      console.log(`✅ Obstáculo ${obstacle.type} adicionado na sala ${roomId}`);
    } else {
      cb && cb({ ok: false, error: "invalid_position" });
    }
  });

  // Selecionar item
  socket.on("selectItem", ({ roomId, itemType }, cb) => {
    console.log(
      `🎯 Jogador ${socket.id} selecionando item ${itemType} na sala ${roomId}`
    );
    const room = rooms[roomId];
    if (!room || room.phase !== "itemSelection") {
      console.log(`❌ Fase incorreta: ${room?.phase}`);
      return cb({ ok: false });
    }

    if (room.takenItems.has(itemType)) {
      console.log(`❌ Item ${itemType} já foi pego`);
      return cb({ ok: false });
    }

    room.takenItems.add(itemType);
    io.to(roomId).emit("itemTaken", { itemType });
    cb({ ok: true });
    console.log(`✅ Item ${itemType} selecionado na sala ${roomId}`);
  });

  // Item colocado
  socket.on("itemPlaced", ({ roomId }) => {
    console.log(`📍 Item colocado pelo jogador ${socket.id} na sala ${roomId}`);
    const room = rooms[roomId];
    if (!room) return;

    room.placedItems.add(socket.id);
    console.log(
      `📊 Items colocados: ${room.placedItems.size}/${
        Object.keys(room.players).length
      }`
    );

    if (room.placedItems.size === Object.keys(room.players).length) {
      room.phase = "playing";
      io.to(roomId).emit("startPlaying");
      io.to(roomId).emit("roomUpdate", {
        ...room,
        players: room.players,
        phase: room.phase,
      });
      startRoundTimer(roomId);
      console.log(`🎮 Iniciando gameplay na sala ${roomId}`);
    }
  });

  // Skip item selection
  socket.on("skipItemSelection", ({ roomId }) => {
    console.log(
      `⏭️ Jogador ${socket.id} pulou seleção de item na sala ${roomId}`
    );
    const room = rooms[roomId];
    if (!room || room.phase !== "itemSelection") return;

    room.placedItems.add(socket.id);
    if (room.placedItems.size === Object.keys(room.players).length) {
      room.phase = "playing";
      io.to(roomId).emit("startPlaying");
      io.to(roomId).emit("roomUpdate", {
        ...room,
        players: room.players,
        phase: room.phase,
      });
      startRoundTimer(roomId);
      console.log(`🎮 Iniciando gameplay na sala ${roomId} (todos pularam)`);
    }
  });

  // Atualização de jogador
  socket.on("playerUpdate", ({ roomId, x, y }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;

    room.players[socket.id].x = x;
    room.players[socket.id].y = y;

    const playerData = {
      id: socket.id,
      name: room.players[socket.id].name,
      x,
      y,
      character: room.players[socket.id].character,
    };

    socket.to(roomId).emit("playerMoved", playerData);
  });

  // Player died
  socket.on("playerDied", ({ roomId }) => {
    console.log(`💀 Jogador ${socket.id} morreu na sala ${roomId}`);
    const room = rooms[roomId];
    if (!room || room.phase !== "playing") return;

    room.deadPlayers.add(socket.id);
    checkRoundEnd(roomId);
  });

  // Reached flag
  socket.on("reachedFlag", ({ roomId }) => {
    console.log(`🏁 Jogador ${socket.id} chegou na bandeira na sala ${roomId}`);
    const room = rooms[roomId];
    if (!room || room.phase !== "playing") return;

    room.reachedFlagPlayers.add(socket.id);
    checkRoundEnd(roomId);
  });

  // Desconexão
  socket.on("disconnect", () => {
    console.log("❌ Desconexão:", socket.id);
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        delete room.players[socket.id];

        // Se era o host, transferir para outro jogador
        if (room.host === socket.id) {
          const remainingPlayers = Object.keys(room.players);
          if (remainingPlayers.length > 0) {
            room.host = remainingPlayers[0];
            console.log(`👑 Novo host da sala ${roomId}: ${room.host}`);
          }
        }

        io.to(roomId).emit("roomUpdate", {
          ...room,
          players: room.players,
          phase: room.phase,
        });

        if (Object.keys(room.players).length === 0) {
          delete rooms[roomId];
          console.log(`🗑️ Sala ${roomId} removida (vazia)`);
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
    return Math.random() - 0.5;
  });

  const newPoints = {};
  arrivalOrder.forEach((id, index) => {
    newPoints[id] = 10 - index;
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
}

function updateProjectiles(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== "playing") return;

  room.projectiles = room.projectiles
    .map((proj) => ({
      ...proj,
      x: proj.x + proj.dir * 5,
    }))
    .filter((proj) => proj.x > 0 && proj.x < 2000);

  room.obstacles.forEach((obs) => {
    if (obs.type === "crossbow" && Math.random() < 0.1) {
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

server.listen(PORT, () => console.log("🚀 Server listening on", PORT));
