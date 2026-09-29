// ESTADO LOCAL DEL DASHBOARD

let aliveWorkerIds = [];
let lastWorkersKey = "";

// CAMPOS DEL PAYLOAD SEGÚN LA CAPACIDAD
// kind: "text" | "textarea" | "number" | "select" | "numbers" (lista) | "vector" (2 números)
// Si una capacidad no está aquí, se muestra un cuadro de JSON libre.

const CAPABILITY_FIELDS = {
    // 1. math_compute
    math_compute: [
        {
            name: "operation",
            label: "Operación",
            kind: "select",
            options: ["add", "sub", "mul", "div"]
        },
        { name: "a", label: "Operando a", kind: "number", placeholder: "Ej: 10" },
        { name: "b", label: "Operando b", kind: "number", placeholder: "Ej: 5" }
    ],
    // 2. http_fetch
    http_fetch: [
        { name: "url", label: "URL", kind: "text", placeholder: "https://..." }
    ],
    // 3. search_text
    search_text: [
        {
            name: "text",
            label: "Texto donde buscar",
            kind: "textarea",
            placeholder: "Ej: hola mundo hola"
        },
        {
            name: "query",
            label: "Palabra a buscar",
            kind: "text",
            placeholder: "Ej: hola"
        }
    ],
    // 4. stats_compute
    stats_compute: [
        {
            name: "numbers",
            label: "Números (separados por coma)",
            kind: "numbers",
            placeholder: "Ej: 1, 2, 3, 4, 5"
        }
    ],
    // 5. vector_distance
    vector_distance: [
        { name: "a", label: "Vector a (x, y)", kind: "vector", placeholder: "Ej: 0, 0" },
        { name: "b", label: "Vector b (x, y)", kind: "vector", placeholder: "Ej: 3, 4" }
    ],
    // 6. http_latency
    http_latency: [
        { name: "url", label: "URL", kind: "text", placeholder: "https://..." }
    ],
    // Propuesta: is_prime
    is_prime: [
        {
            name: "number",
            label: "Número entero",
            kind: "number",
            placeholder: "Ej: 17"
        }
    ]
};

// Capacidad para la que están dibujados los campos ahora mismo
let currentFieldsType = null;

// ESTADOS DE TAREA (valor del backend -> texto y clase CSS)

const ESTADOS_TAREA = {
    en_cola: { texto: "En cola", clase: "queued" },
    enviada: { texto: "En proceso", clase: "running" },
    completada: { texto: "Completada", clase: "done" },
    error: { texto: "Error", clase: "failed" }
};

// INICIALIZACIÓN Y EVENT LISTENERS

document.addEventListener("DOMContentLoaded", () => {
    // Escuchar envíos de formularios sin atribuir onsubmit en HTML
    const addPeerForm = document.getElementById("addPeerForm");
    if (addPeerForm) {
        addPeerForm.addEventListener("submit", (e) => {
            e.preventDefault();
            addPeer();
        });
    }

    const sendTaskForm = document.getElementById("sendTaskForm");
    if (sendTaskForm) {
        sendTaskForm.addEventListener("submit", (e) => {
            e.preventDefault();
            sendTask();
        });
    }

    // Al cambiar de worker, recargar las capacidades disponibles
    const taskWorkerSelect = document.getElementById("taskWorkerSelect");
    if (taskWorkerSelect) {
        taskWorkerSelect.addEventListener("change", updateCapabilities);
    }

    // Al cambiar de capacidad, dibujar los campos que necesita
    const taskTypeSelect = document.getElementById("taskTypeSelect");
    if (taskTypeSelect) {
        taskTypeSelect.addEventListener("change", () => {
            renderPayloadFields(taskTypeSelect.value);
        });
    }

    // Ejecuciones iniciales
    renderPayloadFields("");
    updateState();
    updateWorkers();
    updateTasks();

    // Timers periódicos
    setInterval(updateState, 1500);
    setInterval(updateWorkers, 1500);
    setInterval(updateTasks, 1500);
});

// ACTUALIZAR ESTADO

async function updateState() {
    try {
        const response = await fetch("/election/state");

        if (!response.ok) {
            return;
        }

        const data = await response.json();

        // INFORMACIÓN PRINCIPAL
        document.getElementById("headerNodeName").textContent =
            "Coordinador: " + (data.id || "");

        document.getElementById("sName").textContent =
            data.id || "—";

        // ROL
        const roleEl = document.getElementById("sRole");
        const roleClean = (data.role || "").toLowerCase().trim();

        roleEl.textContent = data.role ? data.role.toUpperCase() : "—";
        roleEl.className = "tag " + roleClean;

        // LÍDER
        document.getElementById("sLeader").textContent =
            data.leader || "Sin Líder";

        document.getElementById("sLeaderUrl").textContent =
            data.leaderUrl || "N/A";

        // PEERS
        const peersUl = document.getElementById("peersList");

        if (!data.peers || data.peers.length === 0) {
            peersUl.innerHTML = `
                <li class="empty-list-item">
                    Sin otros coordinadores registrados
                </li>
            `;
        } else {
            peersUl.innerHTML = data.peers
                .map(
                    (peer) => `
                        <li class="peer-card">
                            <div class="peer-info">
                                <span class="peer-id">
                                    ${escapeHtml(peer.id)}
                                </span>
                                <span class="peer-url">
                                    ${escapeHtml(peer.url)}
                                </span>
                            </div>

                            <span class="status-badge ${peer.alive ? "online" : "offline"
                        }">
                                ${peer.alive ? "● Activo" : "○ Inactivo"}
                            </span>
                        </li>
                    `
                )
                .join("");
        }
    } catch (err) {
        console.error("Error al actualizar estado:", err);
    }
}

// AGREGAR PEER

async function addPeer() {
    const input = document.getElementById("peerUrlInput");
    const url = input.value.trim();

    if (!url) {
        return;
    }

    try {
        const response = await fetch("/election/seed", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ url }),
        });

        if (response.ok) {
            input.value = "";
            await updateState();
        } else {
            const errData = await response.json();
            alert(`Error: ${errData.error || "No se pudo agregar el peer"}`);
        }
    } catch (err) {
        console.error("Error al conectar peer:", err);
        alert("Error de red al intentar agregar el peer");
    }
}

// CAPACIDADES

async function fetchCapabilities(workerId) {
    try {
        const r = await fetch(`/workers/${encodeURIComponent(workerId)}/capabilities`);
        if (!r.ok) return [];
        const data = await r.json();
        return Array.isArray(data.capabilities) ? data.capabilities : [];
    } catch (e) {
        return [];
    }
}

async function updateCapabilities() {
    const workerSelect = document.getElementById("taskWorkerSelect");
    const typeSelect = document.getElementById("taskTypeSelect");
    const ids = workerSelect.value ? [workerSelect.value] : aliveWorkerIds;

    const results = await Promise.all(ids.map(fetchCapabilities));
    const caps = [...new Set(results.flat())];

    const previous = typeSelect.value;
    typeSelect.innerHTML = `<option value="">Selecciona capacidad</option>`;
    caps.forEach((cap) => {
        const option = document.createElement("option");
        option.value = cap;
        option.textContent = cap;
        typeSelect.appendChild(option);
    });
    if (caps.includes(previous)) typeSelect.value = previous;

    // Si la capacidad elegida sigue siendo la misma, no se borra lo que el usuario escribió
    renderPayloadFields(typeSelect.value);
}

// CAMPOS DINÁMICOS DEL PAYLOAD

function renderPayloadFields(type, force = false) {
    if (!force && type === currentFieldsType) return;
    currentFieldsType = type;

    const container = document.getElementById("taskPayloadFields");
    if (!container) return;

    if (!type) {
        container.innerHTML =
            `<p class="hint-text">Selecciona una capacidad para ver los campos.</p>`;
        return;
    }

    const fields = CAPABILITY_FIELDS[type];

    // Capacidad desconocida: JSON libre
    if (!fields) {
        container.innerHTML = `
            <div class="field-group">
                <label for="taskPayloadInput">Payload (JSON)</label>
                <textarea id="taskPayloadInput" placeholder='Payload en JSON, ej: {"numbers": [1, 2, 3]}'></textarea>
            </div>
        `;
        return;
    }

    container.innerHTML = fields
        .map((f) => {
            const id = `field_${f.name}`;
            const placeholder = escapeHtml(f.placeholder || "");

            let control;
            if (f.kind === "textarea") {
                control = `<textarea id="${id}" placeholder="${placeholder}"></textarea>`;
            } else if (f.kind === "select") {
                control = `<select id="${id}">` +
                    f.options
                        .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
                        .join("") +
                    `</select>`;
            } else {
                control = `<input type="text" id="${id}" placeholder="${placeholder}" />`;
            }

            return `
                <div class="field-group">
                    <label for="${id}">${escapeHtml(f.label)}</label>
                    ${control}
                </div>
            `;
        })
        .join("");
}

// Devuelve { payload } si todo está bien, o { error } con el motivo
function buildPayload(type) {
    const fields = CAPABILITY_FIELDS[type];

    // Capacidad desconocida: se lee el JSON tal cual
    if (!fields) {
        const input = document.getElementById("taskPayloadInput");
        const raw = input ? input.value.trim() : "";

        if (!raw) return { error: "Escribe el payload en JSON." };

        try {
            return { payload: JSON.parse(raw) };
        } catch (e) {
            return { error: "El payload debe ser JSON válido." };
        }
    }

    const payload = {};

    for (const f of fields) {
        const el = document.getElementById(`field_${f.name}`);
        const raw = el ? el.value.trim() : "";

        if (!raw) {
            return { error: `Completa el campo: ${f.label}.` };
        }

        if (f.kind === "numbers") {
            const numbers = raw.split(/[,;\s]+/).filter(Boolean).map(Number);

            if (numbers.length === 0 || numbers.some((n) => Number.isNaN(n))) {
                return { error: "Los números deben ser válidos y estar separados por coma." };
            }

            payload[f.name] = numbers;
        } else if (f.kind === "number") {
            const n = Number(raw);

            if (Number.isNaN(n)) {
                return { error: `${f.label} debe ser un número válido.` };
            }

            payload[f.name] = n;
        } else if (f.kind === "vector") {
            const v = raw.replace(/[\[\]]/g, "").split(/[,;\s]+/).filter(Boolean).map(Number);

            if (v.length !== 2 || v.some((n) => Number.isNaN(n))) {
                return { error: `${f.label} debe tener exactamente 2 números.` };
            }

            payload[f.name] = v;
        } else {
            payload[f.name] = raw;
        }
    }

    return { payload };
}

// ACTUALIZAR WORKERS

async function updateWorkers() {
    try {
        const response = await fetch("/workers/list");
        if (!response.ok) {
            console.error("GET /workers/list:", response.status);
            return;
        }

        const workers = (await response.json()).workers || [];
        const workersUl = document.getElementById("workersList");
        const taskSelect = document.getElementById("taskWorkerSelect");

        // LISTA VISUAL
        workersUl.innerHTML = workers.length === 0
            ? `<li class="empty-list-item">Sin workers conectados</li>`
            : workers.map((worker) => `
                <li class="peer-card">
                    <div class="peer-info">
                        <span class="peer-id">${escapeHtml(worker.id)}</span>
                        <span class="peer-url">${escapeHtml(worker.url || "")}</span>
                    </div>
                    <span class="status-badge ${worker.alive ? "online" : "offline"}">
                        ${worker.alive ? "● Activo" : "○ Inactivo"}
                    </span>
                </li>`).join("");

        // SELECT: solo se reconstruye si cambió el conjunto de workers activos
        const alive = workers.filter((w) => w.alive).map((w) => w.id).sort();
        const key = alive.join(",");
        if (key === lastWorkersKey) return;
        lastWorkersKey = key;
        aliveWorkerIds = alive;

        const currentSelection = taskSelect.value;
        taskSelect.innerHTML = `<option value="">Cualquier worker disponible</option>`;
        alive.forEach((id) => {
            const option = document.createElement("option");
            option.value = id;
            option.textContent = id;
            taskSelect.appendChild(option);
        });
        if (alive.includes(currentSelection)) taskSelect.value = currentSelection;

        updateCapabilities();
    } catch (err) {
        console.error("Error al actualizar workers:", err);
    }
}

// ENVIAR TAREA

async function sendTask() {
    const typeSelect = document.getElementById("taskTypeSelect");
    const workerSelect = document.getElementById("taskWorkerSelect");
    const feedback = document.getElementById("taskFeedback");

    const type = typeSelect.value;

    if (!type) {
        feedback.textContent = "Selecciona una capacidad.";
        feedback.className = "feedback-text error";
        return;
    }

    const { payload, error } = buildPayload(type);

    if (error) {
        feedback.textContent = error;
        feedback.className = "feedback-text error";
        return;
    }

    feedback.textContent = "Enviando...";
    feedback.className = "feedback-text";

    try {
        const response = await fetch("/tasks/submit", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                workerId: workerSelect.value || null,
                type,
                payload,
            }),
        });

        const data = await response.json();

        if (response.ok || response.status === 202) {
            // Limpia los campos para la siguiente tarea
            renderPayloadFields(type, true);

            if (data.delivered) {
                feedback.textContent = `Tarea ${data.taskId} enviada al worker ${data.worker}.`;
            } else {
                feedback.textContent = `Tarea ${data.taskId} guardada en cola para ${data.worker}.`;
            }

            feedback.className = "feedback-text success";

            // Muestra la tarea en la tabla sin esperar al siguiente ciclo
            updateTasks();
        } else {
            feedback.textContent = `Error: ${data.error || "No se pudo enviar la tarea"
                }`;
            feedback.className = "feedback-text error";
        }
    } catch (err) {
        console.error("Error al enviar tarea:", err);
        feedback.textContent = "Error de red al enviar la tarea";
        feedback.className = "feedback-text error";
    }
}

// TABLA DE TAREAS (id, worker, tipo, estado, resultado)

async function updateTasks() {
    try {
        const response = await fetch("/tasks/list");
        if (!response.ok) return;

        const tasks = (await response.json()).tasks || [];
        const body = document.getElementById("tasksBody");
        if (!body) return;

        if (tasks.length === 0) {
            body.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-list-item">Aún no se han enviado tareas</td>
                </tr>
            `;
            return;
        }

        body.innerHTML = tasks
            .map((t) => {
                const estado = ESTADOS_TAREA[t.status] ||
                    { texto: t.status || "—", clase: "queued" };

                let resultado = "—";
                if (t.status === "completada" && t.result !== undefined && t.result !== null) {
                    resultado = JSON.stringify(t.result);
                } else if (t.status === "error") {
                    resultado = t.error || "Error desconocido";
                }

                return `
                    <tr>
                        <td class="mono">${escapeHtml(t.taskId)}</td>
                        <td>${escapeHtml(t.worker || "—")}</td>
                        <td>${escapeHtml(t.type || "—")}</td>
                        <td><span class="task-status ${estado.clase}">${escapeHtml(estado.texto)}</span></td>
                        <td class="mono">${escapeHtml(resultado)}</td>
                    </tr>
                `;
            })
            .join("");
    } catch (err) {
        console.error("Error al actualizar tareas:", err);
    }
}

// SEGURIDAD BÁSICA PARA HTML

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}