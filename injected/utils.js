
// https://medium.com/@karenmarkosyan/how-to-manage-promises-into-dynamic-queue-with-vanilla-javascript-9d0d1f8d4df5
class PromiseQueue {
    constructor()
    {
        this.queue = [];
        this.pendingPromise = false;
    }

    enqueue(promise, argument) {
      return new Promise((resolve, reject) => {
          this.queue.push({
              promise,
              argument,
              resolve,
              reject,
          });
          this.dequeue();
      });
    }
  
  dequeue() {
      if (this.workingOnPromise) {
        return false;
      }
      const item = this.queue.shift();
      if (!item) {
        return false;
      }
      const advance = () => {
        // Let the SDK consume the delivered result before starting another state update.
        setTimeout(() => {
          this.workingOnPromise = false;
          this.dequeue();
        }, 0);
      };
      try {
        this.workingOnPromise = true;
        item.promise(item.argument)
          .then((value) => {
            item.resolve(value);
            advance();
          })
          .catch(err => {
            item.reject(err);
            advance();
          })
      } catch (err) {
        item.reject(err);
        advance();
      }
      return true;
    }
}
