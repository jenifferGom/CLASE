const workerIdBadge = document.getElementById("workerIdBadge");
const coordUrlDisplay = document.getElementById("coordUrlDisplay");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const coordUrlInput = document.getElementById("coordUrlInput");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const messageInput = document.getElementById("messageInput");
const messageStatus = document.getElementById("messageStatus");
const sendBtn = document.getElementById("sendBtn");
const logsBox = document.getElementById("logsBox");
const tasksBody = document.getElementById("tasksBody");

// ESTADO

async function refreshStatus() {
    try {
        const res = await fetch("/status");
        const s = await res.json();

        workerIdBadge.textContent = s.name || "worker";

        coordUrlDisplay.textContent =
            s.leaderUrl ||
            s.middlewareUrl ||
            "Sin conectar";

        statusDot.classList.toggle("on", s.connected);

        if (s.connected) {
            statusText.textContent = "Conectado";
        } else if (s.registrando) {
            statusText.textContent = "Conectando...";
        } else if (s.buscandoLider) {
            statusText.textContent = "Buscando líder...";
        } else {
            statusText.textContent = "Desconectado";
        }

    } catch (e) {
        statusText.textContent = "Error consultando estado";
    }
}


// LOGS


async function refreshLogs() {
    try {
        const res = await fetch("/logs");
        const data = await res.json();
        const logs = Array.isArray(data.logs) ? data.logs : [];

        logsBox.innerHTML =
            '<div class="title">--- Registro del Trabajador ---</div>' +
            logs.map(l => `<div>${escapeHtml(String(l))}</div>`).join("");

        logsBox.scrollTop = logsBox.scrollHeight;

    } catch (e) {
        // Silenciar errores de sondeo
    }
}


// TAREAS (id, capacidad, estado y tiempo de ejecución)


async function refreshTasks() {
    try {
        const res = await fetch("/tasks");
        const data = await res.json();
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];

        if (tasks.length === 0) {
            tasksBody.innerHTML =
                '<tr><td colspan="4" class="empty-list-item">Sin tareas todavía</td></tr>';
            return;
        }

        tasksBody.innerHTML = tasks.map(t => {
            const seg = (t.elapsedMs / 1000).toFixed(1) + " s";
            const clase =
                t.status === "completada" ? "ok" :
                t.status === "error" ? "error" : "running";

            return `
                <tr>
                    <td class="mono">${escapeHtml(String(t.taskId))}</td>
                    <td>${escapeHtml(String(t.type))}</td>
                    <td><span class="task-badge ${clase}">${escapeHtml(String(t.status))}</span></td>
                    <td>${seg}</td>
                </tr>`;
        }).join("");

    } catch (e) {
        // Silenciar errores de sondeo
    }
}


// SEGURIDAD HTML

function escapeHtml(str) {
    return str.replace(
        /[&<>"']/g,
        c => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[c])
    );
}


// CONECTAR

connectBtn.addEventListener("click", async () => {
    const url = coordUrlInput.value.trim();

    if (!url) {
        messageStatus.textContent = "Ingresa la URL del coordinador.";
        return;
    }

    connectBtn.disabled = true;
    messageStatus.textContent = "Conectando...";

    try {
        const res = await fetch("/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ middlewareUrl: url })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || "Error conectando");
        }

        messageStatus.textContent = data.message || "Conexión iniciada.";
        setTimeout(refreshStatus, 500);

    } catch (error) {
        messageStatus.textContent = error.message || "Error conectando.";
    } finally {
        connectBtn.disabled = false;
    }
});


// DESCONECTAR


disconnectBtn.addEventListener("click", async () => {
    try {
        const res = await fetch("/disconnect", { method: "POST" });
        const data = await res.json();

        messageStatus.textContent = data.message || "Desconectado.";
        setTimeout(refreshStatus, 300);

    } catch (error) {
        messageStatus.textContent = "Error desconectando.";
    }
});


// ENVIAR MENSAJE


sendBtn.addEventListener("click", async () => {
    const message = messageInput.value.trim();

    if (!message) return;

    sendBtn.disabled = true;
    messageStatus.textContent = "Enviando...";

    try {
        const res = await fetch("/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: message })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || "Error enviando mensaje");
        }

        messageInput.value = "";
        messageStatus.textContent = data.message || "Mensaje enviado.";
        refreshLogs();

    } catch (error) {
        messageStatus.textContent = error.message || "Error enviando mensaje.";
    } finally {
        sendBtn.disabled = false;
    }
});


// INICIO


refreshStatus();
refreshLogs();
refreshTasks();

setInterval(refreshStatus, 2000);
setInterval(refreshLogs, 1500);
setInterval(refreshTasks, 1000);