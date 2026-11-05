const workers = new Map();
let nextWorker = 0;
let nextRequest = 0;
const pending = new Map();
window.harness = {
  create() {
    const id = ++nextWorker;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    worker.onerror = (event) => {
      for (const [key, request] of pending)
        if (request.worker === id) {
          clearTimeout(request.timer);
          pending.delete(key);
          request.reject(new Error(event.message));
        }
    };
    workers.set(id, worker);
    return id;
  },
  call(worker, method, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextRequest;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker ${method} timed out`));
      }, 30000);
      pending.set(id, { resolve, reject, timer, worker });
      workers.get(worker).postMessage({ id, method, args });
    });
  },
  terminate(id) {
    workers.get(id).terminate();
    workers.delete(id);
  },
};
document.querySelector("#status").textContent = "Workers ready";
