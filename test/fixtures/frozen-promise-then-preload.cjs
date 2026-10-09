// Freezes Promise.prototype in every vm context, as hosts that lock down built-ins in all realms do.
const vm = require("node:vm");
const createContext = vm.createContext;
vm.createContext = function frozenPromiseCreateContext(...args) {
  const context = createContext.apply(this, args);
  vm.runInContext("Object.freeze((async () => {})().constructor.prototype)", context);
  return context;
};
