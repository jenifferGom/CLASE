const express = require("express");
const axios = require("axios");
const path = require("path");
require("dotenv").config();
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// FIX: evitar que un error no capturado tumbe el proceso
process.on("unhandledRejection", e => console.error("unhandled:", e));
process.on("uncaughtException", e => console.error("uncaught:", e));

// NORMALIZAR URL
function normalizeUrl(url) {
    if (!url) return url;
    return String(url).trim().replace(/\/+$/, "");
}

// NORMALIZAR PAYLOAD DE ENTRADA (Evita texto plano de la UI)
function normalizarPayloadEntrada(payload) {
    if (!payload) return {};
    if (typeof payload === "string") {
        const texto = payload.trim();
        if (texto.startsWith("Payload en JSON") || texto === "") {
            return {};
        }
        try {
            return JSON.parse(texto);
        } catch (e) {
            return {};
        }
    }
    return payload;
}

// ============================================================
// CONFIGURACIÓN
// Uso: node index.js {PUERTO} {URL_NGROK}
// ============================================================
const PORT = process.argv[2] || process.env.PORT || 3000;
const URL = normalizeUrl(process.argv[3] || process.env.PUBLIC_URL || `http://localhost:${PORT}`);
const ID = process.env.COORDINATOR_ID || "coordinator-Pamela-55222022";
const SEED_URL = normalizeUrl(process.argv[4] || null);

const PING_INTERVAL_MS = 4000;
const LEADER_REAFFIRM_MS = 8000;
const PING_TIMEOUT_MS = 5000;
const MAX_PING_FAILS = 3;

// ESTADO GENERAL
let servers = {};
let peers = {};
let taskResults = {}; 
let tasksLog = {};    

// ESTADO DEL COORDINADOR
let role = "follower";
let leader = null;
let leaderUrl = null;

let term = 0;
let fencingToken = 0;

let electionTimer = null;
let answerReceived = false;
let pingRunning = false;

const startTime = Date.now();

// ARCHIVOS ESTÁTICOS Y UI
app.use(express.static(path.join(__dirname, "public")));
app.use("/js", express.static(path.join(__dirname, "js")));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'coordinador.html'));
});

// COMPARAR IDS
function isGreater(a, b) {
    if (!a || !b) return false;
    return a.toString() > b.toString();
}

function isGreaterOrEqual(a, b) {
    if (!a || !b) return false;
    return a.toString() >= b.toString();
}

// ESTADO
function peersValidos() {
    return Object.values(peers).filter(peer => peer.id && normalizeUrl(peer.url) !== URL);
}

function mapearPeerParaEstado(peer) {
    return {
        id: peer.id,
        url: normalizeUrl(peer.url),
        alive: peer.alive
    };
}

function calcularUptimeSegundos() {
    return Math.floor((Date.now() - startTime) / 1000);
}

function estadoDeFallos() {
    return { paused: false, blocked: [], latency: 0 };
}

function getState() {
    const validos = peersValidos();
    const tamañoCluster = validos.length + 1;

    return {
        id: ID,
        url: URL,
        algo: "bully",
        role,
        leader,
        leaderUrl,
        peers: validos.map(mapearPeerParaEstado),
        term,
        fencingToken,
        quorum: tamañoCluster,
        clusterSize: tamañoCluster,
        timing: "lan",
        uptime: calcularUptimeSegundos(),
        faults: estadoDeFallos()
    };
}

function esPeerUtilizable(peer) {
    return peer.alive && peer.id && normalizeUrl(peer.url) !== URL;
}

function getPeerUrls() {
    return Object.values(peers)
        .filter(esPeerUtilizable)
        .map(peer => normalizeUrl(peer.url));
}

function normalizarNombreWorker(nombreCrudo) {
    return nombreCrudo.toLowerCase().replace(/\s+/g, "_");
}

function respuestaNoSoyLider(res) {
    if (leaderUrl) {
        return res.status(409).json({ leader: leaderUrl, peers: getPeerUrls() });
    }
    return res.status(503).json({ retry: true, peers: getPeerUrls() });
}

function crearOActualizarWorker(nombre, url) {
    const previo = servers[nombre];

    servers[nombre] = {
        name: nombre,
        url,
        lastHeartBeat: Date.now(),
        messages: previo ? previo.messages : [],
        online: true
    };

    return servers[nombre];
}

// REGISTRO DEL WORKER
app.post("/register", (req, res) => {
    const { name, url } = req.body;

    if (!name || !url) {
        return res.status(400).json({ error: "Name and URL required" });
    }

    if (role !== "leader") {
        return respuestaNoSoyLider(res);
    }

    const nombreNormalizado = normalizarNombreWorker(name);
    const urlNormalizada = normalizeUrl(url);

    crearOActualizarWorker(nombreNormalizado, urlNormalizada);

    console.log(`Worker registrado: ${nombreNormalizado} -> ${urlNormalizada}`);

    res.json({
        message: "Server registered successfully",
        leader: URL,
        peers: getPeerUrls()
    });
});

function registrarPulso(nombre) {
    const worker = servers[nombre] ?? {
        name: nombre,
        url: "unknown",
        lastHeartBeat: Date.now(),
        messages: [],
        online: true
    };

    worker.lastHeartBeat = Date.now();
    worker.online = true;
    servers[nombre] = worker;

    return worker;
}

// PULSE DEL WORKER
app.post("/pulse/:name", (req, res) => {
    if (role !== "leader") {
        return respuestaNoSoyLider(res);
    }

    const nombreNormalizado = normalizarNombreWorker(req.params.name);
    registrarPulso(nombreNormalizado);

    res.json({
        message: "Pulse received",
        leader: URL,
        peers: getPeerUrls()
    });
});

function agregarMensajeAWorker(worker, contenido) {
    worker.messages.push({
        type: "message",
        message: contenido,
        timestamp: Date.now()
    });
}

app.post("/send-message/:name", (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: "Message required" });
    }

    const nombreNormalizado = normalizarNombreWorker(req.params.name);
    const worker = servers[nombreNormalizado];

    if (!worker) {
        return res.status(400).json({ error: "Server not found" });
    }

    agregarMensajeAWorker(worker, message);
    console.log(`Message from ${nombreNormalizado}: ${message}`);

    res.json({ message: "Message received successfully" });
});

app.get("/servers", (req, res) => {
    res.json(Object.values(servers));
});

function resumenDeWorker(worker) {
    return {
        id: worker.name,
        url: worker.url,
        alive: worker.online,
        lastHeartBeat: worker.lastHeartBeat
    };
}

function listarWorkers() {
    return Object.values(servers).map(resumenDeWorker);
}

app.get("/workers/list", (req, res) => {
    res.json({ workers: listarWorkers() });
});

// TAREAS (WORKLOAD)
function actualizarResultadoDeTarea(taskId, status, result, error) {
    taskResults[taskId] = { status, result, error, receivedAt: Date.now() };

    Object.values(servers).forEach(worker => {
        worker.messages = worker.messages.filter(message => message.id !== taskId);
    });
}

function registrarTarea(taskId, datos) {
    const previa = tasksLog[taskId] || { taskId, createdAt: Date.now() };
    tasksLog[taskId] = { ...previa, ...datos, updatedAt: Date.now() };
    return tasksLog[taskId];
}

// ENVIAR TAREA (Coordinator -> Worker)
app.post("/tasks/submit", async (req, res) => {
    let { workerId, type, payload } = req.body;

    if (!type) {
        return res.status(400).json({ error: "type (capacidad) es requerido" });
    }

    // NORMALIZAR EL PAYLOAD
    payload = normalizarPayloadEntrada(payload);

    let worker = null;

    if (workerId) {
        worker = servers[workerId];
        if (!worker) {
            return res.status(404).json({ error: "Worker no encontrado" });
        }
        if (!worker.online) {
            return res.status(503).json({ error: "El worker está desconectado" });
        }
    }

    if (!worker) {
        worker = Object.values(servers).find(server => server.online);
        if (!worker) {
            return res.status(503).json({ error: "No hay workers disponibles" });
        }
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const mensajeAssign = {
        type: "task-assign",
        data: { taskId, type, payload }
    };

    registrarTarea(taskId, {
        worker: worker.name,
        type,
        status: "en_cola",
        result: null,
        error: null
    });

    worker.messages.push({ id: taskId, type: "task", capability: type, payload, timestamp: Date.now() });

    if (worker.url && worker.url !== "unknown") {
        try {
            await axios.post(`${normalizeUrl(worker.url)}/task/assign`, mensajeAssign, {
                headers: { "ngrok-skip-browser-warning": "true" },
                timeout: 5000
            });

            worker.messages = worker.messages.filter(message => message.id !== taskId);

            if (tasksLog[taskId] && tasksLog[taskId].status === "en_cola") {
                registrarTarea(taskId, { status: "enviada" });
            }

            console.log(`Tarea ${taskId} (${type}) enviada a ${worker.name}`);

            return res.json({ ok: true, taskId, worker: worker.name, delivered: true });
        } catch (error) {
            console.log(`Worker ${worker.name} no respondió, queda en cola`);

            return res.status(202).json({
                ok: true,
                taskId,
                worker: worker.name,
                delivered: false,
                message: "Tarea almacenada en cola"
            });
        }
    }

    res.status(202).json({
        ok: true,
        taskId,
        worker: worker.name,
        delivered: false,
        message: "Tarea almacenada en cola"
    });
});

// RECIBIR RESULTADO DE TAREA
app.post("/task/receive", (req, res) => {
    const data = req.body.data || req.body;
    const { taskId, status, result, error } = data;

    if (!taskId || !status) {
        return res.status(400).json({ error: "taskId y status son requeridos" });
    }

    actualizarResultadoDeTarea(taskId, status, result, error);

    registrarTarea(taskId, {
        status: status === "ok" ? "completada" : "error",
        result: result ?? null,
        error: error ?? null
    });

    if (status === "ok") {
        console.log(`Tarea ${taskId} completada:`, result);
    } else {
        console.log(`Tarea ${taskId} falló: ${error}`);
    }

    res.json({ status: "received" });
});

app.get("/tasks/list", (req, res) => {
    const tasks = Object.values(tasksLog).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ tasks });
});

app.get("/tasks/:taskId/result", (req, res) => {
    const resultado = taskResults[req.params.taskId];

    if (!resultado) {
        return res.status(404).json({ error: "Resultado no disponible aún" });
    }

    res.json(resultado);
});

app.get("/workers/:name/capabilities", async (req, res) => {
    const nombreNormalizado = normalizarNombreWorker(req.params.name);
    const worker = servers[nombreNormalizado];

    if (!worker) {
        return res.status(404).json({ error: "Worker no encontrado" });
    }

    try {
        const { data } = await axios.get(`${normalizeUrl(worker.url)}/task/capabilities`, {
            headers: { "ngrok-skip-browser-warning": "true" },
            timeout: 3000
        });

        res.json(data);
    } catch (error) {
        res.status(502).json({ error: "No se pudo consultar las capacidades del worker" });
    }
});

app.get("/workers/:name/tasks", (req, res) => {
    const nombreNormalizado = normalizarNombreWorker(req.params.name);
    const worker = servers[nombreNormalizado];

    if (!worker) {
        return res.status(404).json({ error: "Worker no encontrado" });
    }

    const tasks = worker.messages.filter(message => message.type === "task");
    worker.messages = worker.messages.filter(message => message.type !== "task");

    res.json({ tasks });
});

// ELECCIÓN Y CLUSTER
app.get("/election/state", (req, res) => {
    res.json(getState());
});

function registrarPeerDirecto(from) {
    if (!from || !from.id || !from.url) return;
    const url = normalizeUrl(from.url);
    peers[from.id] = { id: from.id, url, alive: true, lastSeen: Date.now(), fails: 0 };
}

function buscarPeerPorUrl(url) {
    return Object.keys(peers).find(key => normalizeUrl(peers[key].url) === url);
}

function aprenderPeerPorUrl(peerUrlRaw) {
    const peerUrl = normalizeUrl(peerUrlRaw);
    if (!peerUrl || peerUrl === URL) return;

    const peerId = buscarPeerPorUrl(peerUrl);

    if (peerId) {
        peers[peerId].alive = true;
        peers[peerId].lastSeen = Date.now();
        return;
    }

    peers[peerUrl] = { id: null, url: peerUrl, alive: true, lastSeen: Date.now(), fails: 0 };
}

function aprenderPeersRecibidos(listaPeers) {
    if (!Array.isArray(listaPeers)) return;
    listaPeers.forEach(aprenderPeerPorUrl);
}

app.post("/election/ping", (req, res) => {
    const { from, peers: receivedPeers } = req.body;
    registrarPeerDirecto(from);
    aprenderPeersRecibidos(receivedPeers);
    res.json(getState());
});

function registrarPeerPorMensaje(from) {
    const url = normalizeUrl(from.url);
    peers[from.id] = { id: from.id, url, alive: true, lastSeen: Date.now(), fails: 0 };
    return url;
}

async function manejarElection(from, fromUrl) {
    if (!isGreater(ID, from.id)) return;
    await sendElectionMessage(fromUrl, "ANSWER");
    startElection();
}

function manejarAnswer(from) {
    answerReceived = true;
    console.log(`${from.id} esta vivo. Espero su eleccion.`);
}

async function manejarCoordinator(from, fromUrl) {
    if (!isGreaterOrEqual(from.id, ID)) {
        console.log(`Ignore lider menor: ${from.id}`);
        if (role === "leader") {
            await sendElectionMessage(fromUrl, "COORDINATOR");
        } else {
            startElection();
        }
        return;
    }

    const cambioLider = leader !== from.id || role !== "follower";
    role = "follower";
    leader = from.id;
    leaderUrl = fromUrl;

    console.log(cambioLider ? `Nuevo lider: ${leader}` : `Lider reafirmado: ${leader}`);
}

const manejadoresDeMensaje = {
    ELECTION: manejarElection,
    ANSWER: manejarAnswer,
    COORDINATOR: manejarCoordinator
};

app.post("/election/message", async (req, res) => {
    const { type, from } = req.body;

    if (!type || !from || !from.id || !from.url) {
        return res.status(400).json({ error: "Invalid election message" });
    }

    const fromUrl = registrarPeerPorMensaje(from);
    console.log(`Mensaje ${type} recibido de ${from.id}`);

    res.json({ ok: true });

    const manejador = manejadoresDeMensaje[type];
    if (manejador) {
        try {
            await manejador(from, fromUrl);
        } catch (e) {
            console.error(`Error manejando ${type}:`, e.message);
        }
    }
});

app.post("/election/seed", (req, res) => {
    let { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: "URL requerida" });
    }

    url = normalizeUrl(url);

    if (url === URL) {
        return res.status(400).json({ error: "No puedes agregar tu propia URL" });
    }

    peers[url] = { id: null, url, alive: true, lastSeen: Date.now(), fails: 0 };
    console.log(`Semilla agregada: ${url}`);
    pingPeers();

    res.json({ ok: true, message: "Semilla agregada", url });
});

function construirPayloadEleccion(type) {
    return {
        type,
        from: { id: ID, url: URL },
        payload: {}
    };
}

function opcionesPeticionEleccion() {
    return {
        headers: { "ngrok-skip-browser-warning": "true" },
        timeout: 3000
    };
}

async function sendElectionMessage(url, type) {
    const targetUrl = normalizeUrl(url);
    const payload = construirPayloadEleccion(type);

    try {
        await axios.post(`${targetUrl}/election/message`, payload, opcionesPeticionEleccion());
    } catch (error) {
        console.log(`No responde ${targetUrl} (${error.response?.status || error.code || error.message})`);
    }
}

function puedeIniciarEleccion() {
    return role !== "candidate" && role !== "leader";
}

function reiniciarEstadoDeEleccion() {
    role = "candidate";
    leader = null;
    leaderUrl = null;
    answerReceived = false;
}

function esPosibleSuperior(peer) {
    return peer.alive && (peer.id === null || isGreater(peer.id, ID));
}

function candidatosSuperiores() {
    return Object.values(peers).filter(esPosibleSuperior);
}

async function consultarSuperiores(candidatos) {
    await Promise.all(candidatos.map(peer => sendElectionMessage(peer.url, "ELECTION")));
}

function programarResolucionDeEleccion() {
    if (electionTimer) {
        clearTimeout(electionTimer);
    }

    electionTimer = setTimeout(() => {
        if (!answerReceived) {
            becomeLeader();
        } else {
            role = "follower";
        }
    }, 3000);
}

async function startElection() {
    if (!puedeIniciarEleccion()) return;

    reiniciarEstadoDeEleccion();
    console.log(`Iniciando eleccion desde ${ID}`);
    await consultarSuperiores(candidatosSuperiores());
    programarResolucionDeEleccion();
}

function asumirRolDeLider() {
    role = "leader";
    leader = ID;
    leaderUrl = URL;
    answerReceived = false;
}

function avanzarGeneracion() {
    term++;
    fencingToken++;
}

function peersVivos() {
    return Object.values(peers).filter(peer => peer.alive);
}

async function notificarCoordinadorATodos(candidatos) {
    await Promise.all(candidatos.map(peer => sendElectionMessage(peer.url, "COORDINATOR")));
}

async function becomeLeader() {
    asumirRolDeLider();
    avanzarGeneracion();

    console.log(`Soy el nuevo lider: ${ID} (term=${term})`);
    await notificarCoordinadorATodos(peersVivos());
}

function construirPayloadSondeo() {
    return {
        from: { id: ID, url: URL },
        peers: Object.values(peers)
            .filter(p => p.url && normalizeUrl(p.url) !== URL)
            .map(p => normalizeUrl(p.url))
    };
}

function actualizarPeerPrincipal(state) {
    if (!state.id || !state.url) return;

    const stateUrl = normalizeUrl(state.url);

    Object.keys(peers).forEach(key => {
        if (normalizeUrl(peers[key].url) === stateUrl && key !== state.id) {
            delete peers[key];
        }
    });

    peers[state.id] = { id: state.id, url: stateUrl, alive: true, lastSeen: Date.now(), fails: 0 };

    if (state.leader) leader = state.leader;
    if (state.leaderUrl) leaderUrl = normalizeUrl(state.leaderUrl);
}

function aprenderPeersDeEstado(state) {
    if (!Array.isArray(state.peers)) return;

    state.peers.forEach(other => {
        const otherUrl = normalizeUrl(other.url);
        if (other.id === ID || !other.id || !otherUrl) return;

        Object.keys(peers).forEach(key => {
            if (normalizeUrl(peers[key].url) === otherUrl && key !== other.id) {
                delete peers[key];
            }
        });

        if (!peers[other.id]) {
            peers[other.id] = { id: other.id, url: otherUrl, alive: other.alive, lastSeen: Date.now(), fails: 0 };
        }
    });
}

function marcarPeerCaido(peer, etiqueta) {
    if (peer.alive) {
        console.log(`Coordinador caido: ${etiqueta}`);
    }
    peer.alive = false;

    if (leader === peer.id) {
        console.log(`El lider ${peer.id} cayo`);
        leader = null;
        leaderUrl = null;
        startElection();
    }
}

async function sondearPeer(peer) {
    const peerUrl = normalizeUrl(peer.url);
    if (!peerUrl || peerUrl === URL) return;

    try {
        const { data: state } = await axios.post(
            `${peerUrl}/election/ping`,
            construirPayloadSondeo(),
            { headers: { "ngrok-skip-browser-warning": "true" }, timeout: PING_TIMEOUT_MS }
        );

        peer.alive = true;
        peer.fails = 0;
        peer.lastSeen = Date.now();

        actualizarPeerPrincipal(state);
        aprenderPeersDeEstado(state);
    } catch (error) {
        peer.fails = (peer.fails || 0) + 1;

        console.log(
            `Ping fallido a ${peer.id || peerUrl} ` +
            `(${peer.fails}/${MAX_PING_FAILS}): ` +
            `${error.response?.status || error.code || error.message}`
        );

        if (peer.fails >= MAX_PING_FAILS) {
            marcarPeerCaido(peer, peer.id || peerUrl);
        }
    }
}

async function pingPeers() {
    if (pingRunning) return;
    pingRunning = true;
    try {
        await Promise.all(Object.values(peers).map(sondearPeer));
    } finally {
        pingRunning = false;
    }
}

function registrarSemillaInicial() {
    if (!SEED_URL) return;
    peers[SEED_URL] = { id: null, url: SEED_URL, alive: true, lastSeen: Date.now(), fails: 0 };
    console.log(`Semilla: ${SEED_URL}`);
}

function logInicio() {
    console.log(`Coordinador ${ID} corriendo`);
    console.log(`URL: ${URL}`);
    console.log(`Puerto: ${PORT}`);
}

function programarTimeoutDeWorkers() {
    const tolerancia = 10000;
    setInterval(() => {
        const ahora = Date.now();
        Object.keys(servers).forEach(name => {
            if (ahora - servers[name].lastHeartBeat > tolerancia) {
                if (servers[name].online) {
                    console.log(`Worker ${name} timed out.`);
                }
                servers[name].online = false;
            }
        });
    }, 5000);
}

function programarSondeoPeriodico() {
    setInterval(() => {
        pingPeers();
    }, PING_INTERVAL_MS);
}

function programarReafirmacionDeLider() {
    setInterval(() => {
        if (role !== "leader") return;
        for (const peer of Object.values(peers)) {
            if (peer.alive) {
                sendElectionMessage(peer.url, "COORDINATOR");
            }
        }
    }, LEADER_REAFFIRM_MS);
}

function programarEleccionInicial() {
    pingPeers();
    setTimeout(() => {
        startElection();
    }, 2000);
}

// INICIO DEL SERVIDOR
app.listen(PORT, () => {
    logInicio();
    registrarSemillaInicial();

    programarTimeoutDeWorkers();
    programarSondeoPeriodico();
    programarReafirmacionDeLider();
    programarEleccionInicial();
});