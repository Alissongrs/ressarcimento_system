/**
 * Serviço de fila para controlar requisições simultâneas
 * Limita a concorrência a um máximo definido
 */

class RequestQueue {
  constructor(maxConcurrency = 5) {
    this.maxConcurrency = maxConcurrency;
    this.queue = [];
    this.active = 0;
    this.processed = new Set();
  }

  /**
   * Adiciona requisição à fila
   * @param {string} key - Chave única para evitar duplicatas
   * @param {Function} fn - Função que retorna Promise
   * @returns {Promise}
   */
  async add(key, fn) {
    if (this.processed.has(key)) {
      return;
    }

    this.processed.add(key);

    return new Promise((resolve, reject) => {
      this.queue.push({ key, fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.active >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    this.active++;
    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.active--;
      this.process();
    }
  }

  reset() {
    this.queue = [];
    this.active = 0;
    this.processed.clear();
  }

  getPending() {
    return this.queue.length;
  }

  getProcessed() {
    return this.processed.size;
  }
}

// Instância global para carregamento de scores
export const scoreQueue = new RequestQueue(5);
