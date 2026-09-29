const express = require("express");
const axios = require("axios");
const path = require("path");
require("dotenv").config();
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const app = express();

app.use(express.json())

// ============================================================
// CONFIGURACIÓN
// Uso: node index.js {PUERTO} {URL_NGROK}
// ============================================================

const norm = u => (u ? String(u).trim().replace(/\/+$/, "") : u)

const PORT = process.argv[2] || process.env.PORT || 3000
const MY_URL = norm(process.argv[3] || process.env.PUBLIC_URL || `http://localhost:${PORT}`)

// ID con el formato del parcial: worker-{nombre}-{código}
const NAME = process.env.WORKER_ID || "worker-jenifer-55222022"

let MIDDLEWARE_URL = null
let leaderUrl = null

let pulseInterval = null
let retryTimer = null

let connected = false
let isSearchingLeader = false
let isRegistering = false
let pulseInProgress = false

// ID -> URL
let knownPeersMap = new Map()

// FIX: header requerido por ngrok
const NGROK_HEADERS = { "ngrok-skip-browser-warning": "true" }

// CAPACIDADES DEL WORKER (parcial: capacidades 3 y 4 + propuesta)

const TASK_LAG_MS = parseInt(process.env.TASK_LAG_MS, 10) || 3000

// Capacidad 3: search_text
function search_text({ text, query }) {
    if (typeof text !== "string" || typeof query !== "string" || query.length === 0) {
        throw new Error("search_text requiere 'text' (string) y 'query' (string no vacío)")
    }

    let count = 0
    let pos = 0

    while ((pos = text.indexOf(query, pos)) !== -1) {
        count++
        pos += query.length
    }

    return { count }
}

// Capacidad 4: stats_compute
function stats_compute({ numbers }) {
    if (!Array.isArray(numbers) || numbers.length === 0 || !numbers.every(n => typeof n === "number")) {
        throw new Error("stats_compute requiere 'numbers' (arreglo no vacío de números)")
    }

    const suma = numbers.reduce((acc, n) => acc + n, 0)
    const mean = suma / numbers.length
    const min = Math.min(...numbers)
    const max = Math.max(...numbers)

    return { mean, min, max }
}

// Capacidad propuesta: prime_range
// Encuentra los números primos dentro de un rango [start, end]
function prime_range({ start, end }) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error("prime_range requiere 'start' y 'end' (números enteros)")
    }
    if (start > end) {
        throw new Error("prime_range requiere que 'start' sea menor o igual a 'end'")
    }
    if (end - start > 1000000) {
        throw new Error("prime_range: el rango máximo es de 1.000.000 de números")
    }

    const esPrimo = n => {
        if (n < 2) return false
        if (n % 2 === 0) return n === 2
        for (let i = 3; i * i <= n; i += 2) {
            if (n % i === 0) return false
        }
        return true
    }

    const primes = []
    for (let n = start; n <= end; n++) {
        if (esPrimo(n)) primes.push(n)
    }

    return { primes, count: primes.length }
}

const CAPABILITIES = { search_text, stats_compute, prime_range }

const CAPABILITY_SCHEMAS = {
    search_text: {
        description: "Cuenta cuántas veces aparece un texto dentro de otro",
        payload: { text: "hola mundo hola", query: "hola" },
        expectedResult: { count: 2 }
    },
    stats_compute: {
        description: "Calcula promedio, mínimo y máximo de un arreglo de números",
        payload: { numbers: [1, 2, 3, 4, 5] },
        expectedResult: { mean: 3, min: 1, max: 5 }
    },
    prime_range: {
        description: "Encuentra los números primos dentro de un rango [start, end]",
        payload: { start: 1, end: 20 },
        expectedResult: { primes: [2, 3, 5, 7, 11, 13, 17, 19], count: 8 }
    }
}

// LOGS PARA LA UI

const logBuffer = []
const originalLog = console.log

console.log = (...args) => {
    originalLog(...args)

    const line = args
        .map(a => {
            if (typeof a === "string") return a
            try {
                return JSON.stringify(a)
            } catch {
                return String(a)
            }
        })
        .join(" ")

    logBuffer.push(`[${new Date().toLocaleTimeString()}] ${line}`)

    if (logBuffer.length > 300) {
        logBuffer.shift()
    }
}


app.use(express.static(path.join(__dirname, "public")))
app.use("/js", express.static(path.join(__dirname, "js")))

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "worker.html"))
})

// CONEXIÓN INICIAL


app.post("/connect", async (req, res) => {
    const { middlewareUrl } = req.body

    if (!middlewareUrl) {
        return res.status(400).json({
            error: "La URL del coordinador es requerida"
        })
    }

    MIDDLEWARE_URL = norm(middlewareUrl)

    console.log("")
    console.log("[CONEXIÓN]")
    console.log(`Worker: ${NAME}`)
    console.log(`Url: ${MIDDLEWARE_URL}`)

    detenerPulsos()

    const exito = await registrarEnLider(MIDDLEWARE_URL)

    if (exito) {
        iniciarPulsos()

        return res.json({
            message: "Conectado exitosamente al líder",
            name: NAME,
            leaderUrl
        })
    }

    buscarNuevoLider()

    return res.json({
        message: "Iniciando búsqueda de líder activo...",
        name: NAME
    })
})


// DESCONECTAR


app.post("/disconnect", (req, res) => {
    detenerPulsos()

    if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
    }

    isSearchingLeader = false
    isRegistering = false
    connected = false
    leaderUrl = null
    MIDDLEWARE_URL = null

    console.log("[DESCONEXIÓN] Desconectando worker.")

    res.json({ message: "Desconectado" })
})


// REGISTRO EN EL LÍDER


async function registrarEnLider(urlCoordinador) {
    if (!NAME || !MY_URL) {
        console.log("[ERROR] NAME o MY_URL no configurados")
        return false
    }

    // Evita registros simultáneos
    if (isRegistering) {
        console.log("[REGISTRO] Ya existe un registro en progreso.")
        return false
    }

    isRegistering = true

    try {
        const url = norm(urlCoordinador)

        console.log(`[REGISTRO] Intentando registrar en: ${url}`)

        const res = await axios.post(
            `${url}/register`,
            {
                id: NAME,
                name: NAME,
                worker: NAME,
                url: MY_URL,
                capabilities: Object.keys(CAPABILITIES),
                schemas: CAPABILITY_SCHEMAS
            },
            {
                headers: NGROK_HEADERS,
                timeout: 3000
            }
        )

        const nuevoLeader = norm(res.data?.leader || url)

        MIDDLEWARE_URL = nuevoLeader
        leaderUrl = nuevoLeader

        extraerPeers(res.data?.peers)

        connected = true
        isSearchingLeader = false

        console.log(`[ÉXITO] Registrado en el líder: ${leaderUrl}`)

        return true
    } catch (error) {
        connected = false

        // 409 = este nodo NO es el líder, pero conoce a quién lo es
        if (
            error.response &&
            error.response.status === 409 &&
            error.response.data?.leader
        ) {
            const verdaderoLider = norm(error.response.data.leader)

            console.log(`[REDIRECCIÓN 409] Líder real: ${verdaderoLider}`)

            extraerPeers(error.response.data?.peers)

            // Evitamos recursión infinita
            if (verdaderoLider === norm(urlCoordinador)) {
                console.log("[REGISTRO] El líder indicado es el mismo nodo consultado.")
                return false
            }

            isRegistering = false

            return await registrarEnLider(verdaderoLider)
        }

        // 503 = el nodo consultado no sabe (todavía) quién es el líder,
        // pero puede traer una lista de peers útil para buscarNuevoLider()
        if (
            error.response &&
            error.response.status === 503
        ) {
            console.log("[REGISTRO 503] El nodo no conoce al líder aún. Guardando peers recibidos.")

            extraerPeers(error.response.data?.peers)
        }

        console.log(`[ALERTA] No se pudo registrar en: ${urlCoordinador}`)

        if (error.response) {
            console.log(`[REGISTRO] HTTP ${error.response.status}`, error.response.data || "")
        } else {
            console.log(`[REGISTRO] ${error.message}`)
        }

        return false
    } finally {
        isRegistering = false
    }
}


// EXTRAER PEERS


function extraerPeers(listaPeers) {
    if (!Array.isArray(listaPeers)) return

    listaPeers.forEach(peer => {
        if (typeof peer === "object" && peer !== null) {
            const url = peer.url ? norm(peer.url) : null
            const id = peer.id ? peer.id.toString().toUpperCase() : null

            if (!url || url === MY_URL) return

            if (id) {
                knownPeersMap.set(id, url)
            } else {
                knownPeersMap.set(url, url)
            }
            return
        }

        if (typeof peer === "string") {
            const url = norm(peer)
            if (url === MY_URL) return
            knownPeersMap.set(url, url)
        }
    })
}


// PULSOS


function detenerPulsos() {
    if (pulseInterval) {
        clearInterval(pulseInterval)
        pulseInterval = null
    }
    pulseInProgress = false
}

function iniciarPulsos() {
    detenerPulsos()

    if (!NAME || !MIDDLEWARE_URL) {
        console.log("[PULSOS] No se pueden iniciar: faltan datos.")
        return
    }

    console.log("[PULSOS] Iniciando pulsos cada 4 segundos.")

    enviarPulso()

    pulseInterval = setInterval(() => {
        enviarPulso()
    }, 4000)
}

async function enviarPulso() {
    if (isSearchingLeader) return
    if (isRegistering) return

    if (pulseInProgress) {
        console.log("[PULSO] Ya existe un pulso en progreso.")
        return
    }

    if (!NAME || !MIDDLEWARE_URL || !connected) return

    pulseInProgress = true

    const liderActual = MIDDLEWARE_URL

    console.log(`[PULSO] ${NAME} -> ${liderActual}`)

    try {
        const res = await axios.post(
            `${liderActual}/pulse/${NAME}`,
            {},
            {
                headers: NGROK_HEADERS,
                timeout: 3000
            }
        )

        connected = true

        extraerPeers(res.data?.peers)

        if (res.data?.leader) {
            const liderInformado = norm(res.data.leader)

            if (liderInformado !== leaderUrl) {
                console.log(`[PULSO] El líder informa nuevo líder: ${liderInformado}`)
                leaderUrl = liderInformado
            }
        }

        console.log(`[PULSO] OK -> ${liderActual}`)
    } catch (error) {
        if (error.response && error.response.status === 409) {
            const liderInformado = error.response.data?.leader
                ? norm(error.response.data.leader)
                : null

            extraerPeers(error.response.data?.peers)

            console.log("[PULSO 409] El líder rechazó el pulso.")
            console.log(`[PULSO 409] Líder actual: ${liderActual}`)
            console.log(`[PULSO 409] Líder informado: ${liderInformado}`)

            if (liderInformado && liderInformado !== liderActual) {
                console.log(`[CAMBIO DE LÍDER] ${liderActual} -> ${liderInformado}`)

                detenerPulsos()
                connected = false

                const ok = await registrarEnLider(liderInformado)

                if (ok) {
                    iniciarPulsos()
                    return
                }

                buscarNuevoLider()
                return
            }

            console.log("[PULSO 409] El líder informado es el mismo.")
            console.log("[PULSO 409] Se detienen los pulsos y se inicia una búsqueda.")

            detenerPulsos()
            connected = false

            buscarNuevoLider()
            return
        }

        // Si el 503 trae peers, aprovechamos esa info también aquí
        if (error.response && error.response.status === 503) {
            extraerPeers(error.response.data?.peers)
        }

        console.log(`[LÍDER CAÍDO] ${liderActual}`)

        if (error.response) {
            console.log(`[PULSO] HTTP ${error.response.status}`, error.response.data || "")
        } else {
            console.log(`[PULSO] ${error.message}`)
        }

        detenerPulsos()
        connected = false

        buscarNuevoLider()
    } finally {
        pulseInProgress = false
    }
}


// BUSCAR NUEVO LÍDER


function buscarNuevoLider() {
    if (isSearchingLeader) return

    isSearchingLeader = true
    connected = false

    detenerPulsos()

    console.log("[BÚSQUEDA] Líder caído. Buscando nuevo líder...")

    ejecutarRondaBusqueda()
}

async function ejecutarRondaBusqueda() {
    if (!isSearchingLeader) return

    const entries = Array.from(knownPeersMap.entries())

    // Orden descendente por ID completo (worker-nombre-código)
    entries.sort((a, b) => {
        const idA = a[0]
        const idB = b[0]
        return idB.localeCompare(idA)
    })

    console.log(
        "[BÚSQUEDA] Peers:",
        entries.map(([id, url]) => `${id}: ${url}`)
    )

    for (const [id, url] of entries) {
        if (!isSearchingLeader) return
        if (url === MY_URL) continue

        try {
            console.log(`[VERIFICANDO] ${id} -> ${url}`)

            const res = await axios.get(`${url}/election/state`, {
                headers: NGROK_HEADERS,
                timeout: 2000
            })

            const estado = res.data

            extraerPeers(estado?.peers)

            if (estado?.role === "leader") {
                console.log(`[NUEVO LÍDER] ${url} -> ${url}`)

                const ok = await registrarEnLider(url)

                if (ok) {
                    isSearchingLeader = false
                    iniciarPulsos()
                    return
                }
            }

            if (estado?.leaderUrl) {
                const targetUrl = norm(estado.leaderUrl)

                console.log(`[INFORMADOR] ${url} indica líder: ${targetUrl}`)

                const ok = await registrarEnLider(targetUrl)

                if (ok) {
                    isSearchingLeader = false
                    iniciarPulsos()
                    return
                }
            }
        } catch (error) {
            console.log(`[INACCESIBLE] ${id} -> ${url}`)
        }
    }

    if (!isSearchingLeader) return

    if (retryTimer) clearTimeout(retryTimer)

    retryTimer = setTimeout(() => {
        retryTimer = null
        ejecutarRondaBusqueda()
    }, 1500)
}


// ENVIAR MENSAJE


app.post("/send-message", async (req, res) => {
    const { message } = req.body

    if (!message) {
        return res.status(400).json({ error: "El mensaje es requerido" })
    }

    if (!connected) {
        buscarNuevoLider()

        return res.status(503).json({
            error: "Reconectando al nuevo líder. Intenta nuevamente."
        })
    }

    try {
        await axios.post(
            `${MIDDLEWARE_URL}/send-message/${NAME}`,
            { message },
            {
                headers: NGROK_HEADERS,
                timeout: 3000
            }
        )

        res.json({ message: "Mensaje entregado con éxito." })
    } catch (error) {
        console.log("[MENSAJE] Error comunicando con líder.")

        connected = false

        buscarNuevoLider()

        res.status(503).json({
            error: "Error enviando mensaje. Reubicando líder..."
        })
    }
})

// ============================================================
// TAREAS (WORKLOAD) - task/capabilities, task/assign
// ============================================================

// GET /task/capabilities: capacidades + esquemas de ejemplo
app.get("/task/capabilities", (req, res) => {
    res.json({
        worker: NAME,
        capabilities: Object.keys(CAPABILITIES),
        schemas: CAPABILITY_SCHEMAS
    })
})

// POST /task/assign: el coordinador (líder) asigna una tarea a este worker
app.post("/task/assign", (req, res) => {
    const body = req.body.data || req.body
    const { taskId, type, payload } = body

    if (!taskId || !type) {
        return res.status(400).json({ error: "taskId y type son requeridos" })
    }

    if (!CAPABILITIES[type]) {
        return res.status(400).json({ error: `Capacidad no soportada: ${type}` })
    }

    console.log(`[TAREA] Recibida ${taskId} (${type}). Lag simulado: ${TASK_LAG_MS}ms`)

    // Confirmamos la recepción de inmediato; el trabajo real ocurre en segundo plano
    res.json({ status: "accepted", taskId })

    setTimeout(() => {
        ejecutarTareaYReportar(taskId, type, payload)
    }, TASK_LAG_MS)
})

async function ejecutarTareaYReportar(taskId, type, payload) {
    let mensaje

    try {
        const result = CAPABILITIES[type](payload)
        mensaje = { type: "task-result", data: { taskId, status: "ok", result } }

        console.log(`[TAREA] ${taskId} completada:`, result)
    } catch (error) {
        mensaje = { type: "task-result", data: { taskId, status: "error", error: error.message } }

        console.log(`[TAREA] ${taskId} falló: ${error.message}`)
    }

    // Reportamos al líder actual (quien nos asignó la tarea debería seguir siendo el líder)
    const destino = MIDDLEWARE_URL || leaderUrl

    if (!destino) {
        console.log(`[TAREA] No hay líder conocido; no se pudo reportar ${taskId}`)
        return
    }

    try {
        await axios.post(`${destino}/task/receive`, mensaje, {
            headers: NGROK_HEADERS,
            timeout: 3000
        })
    } catch (error) {
        console.log(`[TAREA] Error reportando resultado de ${taskId} a ${destino}: ${error.message}`)
    }
}

// ESTADO


app.get("/status", (req, res) => {
    res.json({
        connected,
        buscandoLider: isSearchingLeader,
        registrando: isRegistering,
        pulsoEnProgreso: pulseInProgress,
        name: NAME,
        middlewareUrl: MIDDLEWARE_URL,
        leaderUrl: leaderUrl,
        knownPeers: Object.fromEntries(knownPeersMap)
    })
})


// LOGS


app.get("/logs", (req, res) => {
    res.json({ logs: logBuffer })
})


// START

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Worker iniciado en: ${MY_URL}`)
    console.log(`Trabajador: ${NAME}`)
    console.log(`Puerto: ${PORT}`)
})