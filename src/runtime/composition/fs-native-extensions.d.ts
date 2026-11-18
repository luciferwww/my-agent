declare module 'fs-native-extensions' {
  const locks: {
    tryLock(fd: number, offset?: number, length?: number): boolean;
  };
  export default locks;
}
