const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const path = require('path');

// Firebase Admin SDK Initialization
try {
  const serviceAccountPath = path.resolve(__dirname, 'credential', 'serviceAccountKey.json');
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully.');
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
  process.exit(1);
}

const db = admin.firestore();
const eventsCollection = db.collection('events');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  }
});

const PORT = process.env.PORT || 4000;

// In-Memory State
const eventTimers = {};
const hostSocketToEventCode = {};

// Helper function to generate a unique 4-digit event code
const generateCode = async () => {
  let code;
  let docExists;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
    const doc = await eventsCollection.doc(code).get();
    docExists = doc.exists;
  } while (docExists);
  return code;
};

// End event and cleanup
const endEvent = async (eventCode) => {
  if (!eventCode) return;

  console.log(`Ending event ${eventCode}...`);

  if (eventTimers[eventCode]) {
    clearInterval(eventTimers[eventCode]);
    delete eventTimers[eventCode];
  }

  io.to(eventCode).emit('eventEnded');

  try {
    const eventDoc = eventsCollection.doc(eventCode);
    const eventData = (await eventDoc.get()).data();

    if (eventData && eventData.hostSocketId) {
      delete hostSocketToEventCode[eventData.hostSocketId];
    }

    await eventDoc.delete();
    console.log(`Event ${eventCode} has ended and cleaned up.`);
  } catch (error) {
    console.error(`Error ending event ${eventCode}:`, error);
  }
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('createEvent', async ({ hostId }) => {
    const existingEventCode = hostSocketToEventCode[socket.id];

    if (existingEventCode) {
      await endEvent(existingEventCode);
    }

    const newCode = await generateCode();

    await eventsCollection.doc(newCode).set({
      hostFirebaseId: hostId,
      hostSocketId: socket.id,
      state: 'waiting',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    hostSocketToEventCode[socket.id] = newCode;
    socket.join(newCode);
    socket.emit('hostCode', newCode);

    console.log(`New event created by host ${hostId} (${socket.id}) with code: ${newCode}`);
  });

  socket.on('joinEvent', async ({ eventCode, teamId, teamName, section }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      if (eventSnapshot.exists) {
        const eventData = eventSnapshot.data();

        if (eventData.state === 'playing') {
          socket.emit('joinResponse', {
            success: false,
            message: 'This game is already in progress. Please wait for the next round.'
          });
          return;
        }

        socket.join(eventCode);
        console.log(`${teamName} (${teamId}) joined event ${eventCode}`);

        socket.emit('joinResponse', {
          success: true,
          eventCode,
          gameState: eventData.state || 'waiting',
          time: 0
        });

        io.to(eventData.hostSocketId).emit('playerJoined', { teamName, section });

        try {
          const leaderboardSnapshot = await eventDoc.collection('leaderboard')
            .orderBy('time')
            .get();
          const leaderboard = leaderboardSnapshot.docs.map(doc => doc.data());
          socket.emit('leaderboardUpdate', leaderboard);
        } catch (error) {
          console.error('Error fetching leaderboard on joinEvent:', error);
        }
      } else {
        socket.emit('joinResponse', {
          success: false,
          message: 'Invalid event code.'
        });
      }
    } catch (error) {
      console.error('Error processing joinEvent:', error);
      socket.emit('joinResponse', {
        success: false,
        message: 'Internal server error.'
      });
    }
  });

  socket.on('startGame', async ({ eventCode }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        await eventDoc.update({ state: 'playing' });

        io.to(eventCode).emit('gameStateUpdate', { state: 'playing', time: 0 });

        let currentTime = 0;
        eventTimers[eventCode] = setInterval(() => {
          currentTime += 100;
          io.to(eventCode).emit('timerUpdate', currentTime);
        }, 100);

        console.log(`Game for event ${eventCode} started by host.`);
      }
    } catch (error) {
      console.error('Error starting game:', error);
    }
  });

  socket.on('restartGame', async ({ eventCode }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        console.log(`Restarting game for event ${eventCode}.`);

        if (eventTimers[eventCode]) {
          clearInterval(eventTimers[eventCode]);
          delete eventTimers[eventCode];
        }

        await eventDoc.update({ state: 'waiting' });

        io.to(eventCode).emit('gameStateUpdate', { state: 'waiting' });
        io.to(eventCode).emit('timerUpdate', 0);

        const leaderboardSnapshot = await eventDoc.collection('leaderboard').orderBy('time').get();
        const leaderboard = leaderboardSnapshot.docs.map(doc => doc.data());
        io.to(eventCode).emit('leaderboardUpdate', leaderboard);
      }
    } catch (error) {
      console.error('Error restarting game:', error);
    }
  });

  socket.on('endEvent', async ({ eventCode }) => {
    try {
      const eventDoc = eventsCollection.doc(eventCode);
      const eventSnapshot = await eventDoc.get();

      if (eventSnapshot.exists && eventSnapshot.data().hostSocketId === socket.id) {
        await endEvent(eventCode);
        console.log(`Event ${eventCode} ended by host.`);
      }
    } catch (error) {
      console.error('Error ending event:', error);
    }
  });

  socket.on('submitTime', async ({ eventCode, teamId, teamName, section, time }) => {
    const scoreData = {
      name: teamName,
      section: section,
      time: time,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    try {
      const eventDoc = eventsCollection.doc(eventCode);
      await eventDoc.collection('leaderboard').doc(teamId).set(scoreData);

      const leaderboardSnapshot = await eventDoc.collection('leaderboard').orderBy('time').get();
      const leaderboard = leaderboardSnapshot.docs.map(doc => doc.data());
      io.to(eventCode).emit('leaderboardUpdate', leaderboard);
    } catch (error) {
      console.error('Error saving score or fetching leaderboard:', error);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.id}`);
    const eventCodeToEnd = hostSocketToEventCode[socket.id];
    if (eventCodeToEnd) {
      console.log(`Host for event ${eventCodeToEnd} disconnected. Ending event.`);
      await endEvent(eventCodeToEnd);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
