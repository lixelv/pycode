declare module "monaco-esm/*"
declare module "monaco-esm/editor/editor.worker.js?worker" {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
