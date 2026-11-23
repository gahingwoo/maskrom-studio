// esbuild's binary loader: a file imported as its bytes (test/electron workers).
declare module '*.bin' {
  const data: Uint8Array;
  export default data;
}
