import {
  ConnectionProvider,
  useConnection,
  useWallet,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import * as web3 from "@solana/web3.js";

import {
  getLedgerWallet,
  getPhantomWallet,
  getSlopeWallet,
  getSolflareWallet,
} from "@solana/wallet-adapter-wallets";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  WalletModalProvider,
} from "@solana/wallet-adapter-react-ui";

import Console from "./Console";
import { ResponsiveMonacoEditor } from "./Monaco";
import WalletButton from "./WalletButton";
import { useSlotInfo } from "./useWeb3";
import Tree, { TreeProvider } from "./Tree";
import { monaco } from "react-monaco-editor";
import Parser from "web-tree-sitter";
import Tabs from "./Tabs";
import { markEditorErrors } from "./Editor";

import { useLanguageParser } from "./useTreeSitter";
import { LLVMProvider, useFileSystem, useLLVM } from "./useLLVM";
import { useExampleCode, useSysroot } from "./useAlon";
import { LogProvider, useLogs } from "./Log";
import { SaveIcon, TrashIcon, UploadIcon } from "@heroicons/react/outline";

import SHA from "jssha";
import * as sha3 from "js-sha3";
import { useAsyncFn, useMountedState } from "react-use";
import Modal from "react-modal";
import * as zip from "@zip.js/zip.js";
import { TokenAccounts } from "./TokenAccounts";
import { useRef } from "react";

const App = () => {
  const wallets = useMemo(
    () => [
      getPhantomWallet(),
      getSlopeWallet(),
      getSolflareWallet(),
      getLedgerWallet(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={web3.clusterApiUrl("devnet")}>
      <WalletProvider wallets={wallets}>
        <WalletModalProvider>
          <LogProvider>
            <LLVMProvider>
              <Main />
            </LLVMProvider>
          </LogProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

const SlotInfo = () => {
  const slotInfo = useSlotInfo();

  return (
    <dl>
      <div className="grid grid-cols-2 gap-4 text-xs">
        <dt className="font-medium text-gray-500">Slot Number</dt>
        <dd className="text-gray-900 justify-self-end">{slotInfo?.slot.toLocaleString() ?? '-'}</dd>
      </div>
      <div className="grid grid-cols-2 gap-4 text-xs">
        <dt className="font-medium text-gray-500">Root Number</dt>
        <dd className="text-gray-900 justify-self-end">{slotInfo?.root.toLocaleString() ?? '-'}</dd>
      </div>
      <div className="grid grid-cols-2 gap-4 text-xs">
        <dt className="font-medium text-gray-500">Parent Number</dt>
        <dd className="text-gray-900 justify-self-end">{slotInfo?.parent.toLocaleString() ?? '-'}</dd>
      </div>
    </dl>
  );
}

const Main = () => {
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    setEditor(editor);
  }, [setEditor]);

  const sysrootLoadState = useSysroot();
  const sysrootLoaded = !sysrootLoadState.loading && sysrootLoadState.value === true;

  useExampleCode(editor, sysrootLoaded);

  const parser = useLanguageParser("tree-sitter-c.wasm");
  const [tree, setTree] = useState<Parser.Tree | null>(null);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const changeModelHandler = editor.onDidChangeModel(event => {
      editor.updateOptions({ readOnly: event.newModelUrl?.path.startsWith("/usr") || !event.newModelUrl?.path.endsWith(".c") });
      setTree(null);
    });
    return () => {
      changeModelHandler.dispose();
    }
  }, [editor]);

  const { fs, sync } = useFileSystem();

  const [files, setFiles] = useState<any[]>([]);

  const getFileName = useCallback(node => node.name, []);
  const getFileChildren = useCallback(node => {
    if (!node.isFolder) return undefined;

    return Object.values(node.contents).sort((a: any, b: any): number => {
      if (a.isFolder === b.isFolder) {
        return (a.name as string).localeCompare(b);
      }
      return a.isFolder ? -1 : 1;
    });
  }, []);
  const handleFileClicked = useCallback(node => {
    if (!editor || !fs) return;

    const uri = monaco.Uri.file(fs.getPath(node));

    let model = monaco.editor.getModel(uri)
    if (model === null) {
      const contents = !node.contents ? "" : new TextDecoder().decode(node.contents);
      model = monaco.editor.createModel(contents, undefined, uri);
    }

    editor.setModel(model);
  }, [editor, fs]);

  useEffect(() => {
    let isMounted = true;
    if (!fs || !sysrootLoaded) {
      if (isMounted) setFiles([]);
      return;
    }
    if (isMounted) setFiles(["/project", "/usr/include/solana"].map(path => fs.lookupPath(path, {}).node));
    return () => {
      isMounted = false;
    }
  }, [fs, sysrootLoaded]);

  const log = useLogs();
  const { llvm, compiler } = useLLVM();

  const [compilation, handleClickCompile] = useAsyncFn(async () => {
    if (!editor || !llvm || !fs || !compiler || !sysrootLoaded) {
      return;
    }

    const getSourceFileNames = (node: any): string[] => {
      const names = [];
      if (node.isFolder) {
        for (const child of Object.values(node.contents)) {
          names.push(...getSourceFileNames(child));
        }
      } else {
        const nodePath = fs.getPath(node);
        if (nodePath.endsWith(".c")) {
          names.push(nodePath);
        }
      }
      return names;
    };

    const root = fs.lookupPath("/project", {}).node;
    const sourceFileNames = getSourceFileNames(root);

    const baseCompilerArgs = [
      "-Werror",
      "-O2",
      "-fno-builtin",
      "-std=c17",
      "-isystem/usr/include/clang",
      "-isystem/usr/include/solana",
      "-mrelocation-model",
      "pic",
      "-pic-level",
      "2",
      "-emit-obj",
      "-I/project/",
      "-triple",
      "bpfel-unknown-unknown-bpfel+solana",
    ];

    log.write("compiler", "Compiling with arguments:")
    log.write("compiler", baseCompilerArgs);

    for (const sourceFileName of sourceFileNames) {
      const compilerArgs = [...baseCompilerArgs, "-o", `${sourceFileName.slice(0, -2)}.o`, sourceFileName];

      const compilerArgsList = new llvm.StringList();
      compilerArgs.forEach(arg => compilerArgsList.push_back(arg));

      const compileResult = await compiler.compile(compilerArgsList);
      if (!compileResult.success) {
        log.write("compiler", "Error while compiling:");
        log.write("compiler", compileResult.diags);

        for (const sourceFileName of sourceFileNames) {
          try {
            fs.unlink(`${sourceFileName.slice(0, -2)}.o`);
          } catch { }
        }

        return;
      }
    }

    try {
      fs.unlink("/project/program.so");
    } catch { }

    const linkerArgs = [
      "-z",
      "notext",
      "-shared",
      "--Bdynamic",
      "/usr/share/bpf.ld",
      "--entry",
      "entrypoint",
      "/usr/lib/libcompiler_builtins.rlib",
      "-o",
      "/project/program.so",
    ];

    for (const sourceFileName of sourceFileNames) {
      linkerArgs.push(`${sourceFileName.slice(0, -2)}.o`);
    }

    const linkerArgsList = new llvm.StringList();
    linkerArgs.forEach(arg => linkerArgsList.push_back(arg));

    log.write("compiler", "Linking with arguments:");
    log.write("compiler", linkerArgs);

    const linkResult = await compiler.linkBpf(linkerArgsList);

    for (const sourceFileName of sourceFileNames) {
      try {
        fs.unlink(`${sourceFileName.slice(0, -2)}.o`);
      } catch { }
    }

    if (!linkResult.success) {
      log.write("compiler", "Error while linking:");
      log.write("compiler", linkResult.err);
      return;
    }

    log.write("compiler", `Successfully linked 'program.so'.`);

    sync();
  }, [log, editor, fs, sync, llvm, compiler, sysrootLoaded]);

  const [testRunner, handleClickRunTests] = useAsyncFn(async () => {
    if (!editor || !llvm || !fs || !compiler || !sysrootLoaded) {
      return;
    }

    const getSourceFileNames = (node: any): string[] => {
      const names = [];
      if (node.isFolder) {
        for (const child of Object.values(node.contents)) {
          names.push(...getSourceFileNames(child));
        }
      } else {
        const nodePath = fs.getPath(node);
        if (nodePath.endsWith(".c")) {
          names.push(nodePath);
        }
      }
      return names;
    };

    const root = fs.lookupPath("/project", {}).node;
    const sourceFileNames = getSourceFileNames(root);

    const baseCompilerArgs = [
      "-Werror",
      "-O2",
      "-fno-builtin",
      "-std=c17",
      "-isystem/usr/include/clang",
      "-isystem/usr/include/solana",
      "-mrelocation-model",
      "pic",
      "-pic-level",
      "2",
      "-emit-obj",
      "-I/project/",
      "-triple",
      "wasm32-unknown-unknown",
      "-DALON_TEST",
    ];

    log.write("compiler", "Compiling tests with arguments:")
    log.write("compiler", baseCompilerArgs);

    for (const sourceFileName of sourceFileNames) {
      const compilerArgs = [...baseCompilerArgs, "-o", `${sourceFileName.slice(0, -2)}.o`, sourceFileName];

      const compilerArgsList = new llvm.StringList();
      compilerArgs.forEach(arg => compilerArgsList.push_back(arg));

      const compileResult = await compiler.compile(compilerArgsList);
      if (!compileResult.success) {
        log.write("compiler", "Error while compiling tests:");
        log.write("compiler", compileResult.diags);

        for (const sourceFileName of sourceFileNames) {
          try {
            fs.unlink(`${sourceFileName.slice(0, -2)}.o`);
          } catch { }
        }

        return;
      }
    }

    try {
      fs.unlink("/project/test.wasm");
    } catch { }

    const linkerArgs = [
      "--no-entry",
      "--import-memory",
      "--export-all",
      "--allow-undefined",
      "-o",
      "/project/test.wasm",
    ];

    for (const sourceFileName of sourceFileNames) {
      linkerArgs.push(`${sourceFileName.slice(0, -2)}.o`);
    }

    const linkerArgsList = new llvm.StringList();
    linkerArgs.forEach(arg => linkerArgsList.push_back(arg));

    log.write("compiler", "Linking tests with arguments:");
    log.write("compiler", linkerArgs);

    const linkResult = await compiler.linkWasm(linkerArgsList);

    for (const sourceFileName of sourceFileNames) {
      try {
        fs.unlink(`${sourceFileName.slice(0, -2)}.o`);
      } catch { }
    }

    if (!linkResult.success) {
      log.write("compiler", "Error while linking tests:");
      log.write("compiler", linkResult.err);
      return;
    }
    log.write("compiler", `Successfully linked 'test.wasm'.`);

    const bytes = fs.readFile("/project/test.wasm");

    try {
      fs.unlink(`/project/test.wasm`);
    } catch { }

    console.log("LINKED");

    const memory = new WebAssembly.Memory({ initial: 2 });
    const buffer = new Uint8Array(memory.buffer);

    const slice = (ptr: number, len: number) => {
      return buffer.slice(ptr, ptr + Number(len));
    }

    const blake3 = await import("blake3/browser");

    console.log("BEFORE");

    try {
      const { instance } = await WebAssembly.instantiate(bytes, {
        env: {
          memory,
          sol_panic_(file: number, len: number, line: number, column: number) {
            throw new Error(`Panic in ${new TextDecoder().decode(slice(file, len))} at ${line}:${column}`);
          },
          sol_log_(ptr: number, len: number) {
            log.write("compiler", `Program log: ${new TextDecoder().decode(slice(ptr, len))}`);
          },
          sol_log_64_(a: number, b: number, c: number, d: number, e: number) {
            log.write("compiler", `Program log: ${a}, ${b}, ${c}, ${d}, ${e}`);
          },
          sol_log_compute_units_() {
            log.write("compiler", `Program consumption: __ units remaining`);
          },
          sol_log_pubkey(ptr: number) {
            log.write("compiler", `Program log: ${new web3.PublicKey(slice(ptr, 32)).toBase58()}`);
          },
          sol_create_program_address(seeds: number, seeds_len: number, program_id: number, program_address: number) {
            let payload = Buffer.of();
            for (let i = 0; i < seeds_len; i++) {
              const view = new DataView(buffer.buffer, seeds + i * 16, 16);
              payload = Buffer.concat([payload, Buffer.from(slice(view.getUint32(0, true), view.getUint32(8, true)))]);
            }
            payload = Buffer.concat([payload, Buffer.from(slice(program_id, 32)), Buffer.from("ProgramDerivedAddress")]);

            const hasher = new SHA("SHA-256", "UINT8ARRAY");
            hasher.update(payload);

            const hash = hasher.getHash("UINT8ARRAY");
            if (web3.PublicKey.isOnCurve(hash)) {
              return BigInt(1);
            }

            buffer.set(hash, program_address);

            return BigInt(0);
          },
          sol_try_find_program_address(seeds: number, seeds_len: number, program_id: number, program_address: number, bump_seed: number) {
            for (let nonce = 255; nonce > 0; nonce--) {
              let payload = Buffer.of();
              for (let i = 0; i < seeds_len; i++) {
                const view = new DataView(buffer.buffer, seeds + i * 16, 16);
                payload = Buffer.concat([payload, Buffer.from(slice(view.getUint32(0, true), view.getUint32(8, true)))]);
              }
              payload = Buffer.concat([payload, Buffer.of(nonce), Buffer.from(slice(program_id, 32)), Buffer.from("ProgramDerivedAddress")]);

              const hasher = new SHA("SHA-256", "UINT8ARRAY");
              hasher.update(payload);

              const hash = hasher.getHash("UINT8ARRAY");
              if (!web3.PublicKey.isOnCurve(hash)) {
                buffer.set(hash, program_address);
                buffer.set([nonce], bump_seed);
                return BigInt(0);
              }
            }
            return BigInt(1);
          },
          sol_sha256: (bytes: number, bytes_len: number, result_ptr: number) => {
            const hasher = new SHA("SHA-256", "UINT8ARRAY");
            for (let i = 0; i < bytes_len; i++) {
              // A slice is assumed to be 16 bytes.
              // Offset 0 is a 4-byte LE number depicting the slice's pointer.
              // 8 is a 4-byte LE number depicting the slice's length.
              const view = new DataView(buffer.buffer, bytes + i * 16, 16);
              hasher.update(slice(view.getUint32(0, true), view.getUint32(8, true)));
            }

            buffer.set(hasher.getHash("UINT8ARRAY"), result_ptr);
            return BigInt(0);
          },
          sol_keccak256: (bytes: number, bytes_len: number, result_ptr: number) => {
            const hasher = sha3.keccak256.create();
            for (let i = 0; i < bytes_len; i++) {
              // A slice is assumed to be 16 bytes.
              // Offset 0 is a 4-byte LE number depicting the slice's pointer.
              // 8 is a 4-byte LE number depicting the slice's length.
              const view = new DataView(buffer.buffer, bytes + i * 16, 16);
              hasher.update(slice(view.getUint32(0, true), view.getUint32(8, true)));
            }

            buffer.set(hasher.digest(), result_ptr);
            return BigInt(0);
          },
          sol_blake3: (bytes: number, bytes_len: number, result_ptr: number) => {
            const hasher = blake3.createHash();
            for (let i = 0; i < bytes_len; i++) {
              // A slice is assumed to be 16 bytes.
              // Offset 0 is a 4-byte LE number depicting the slice's pointer.
              // 8 is a 4-byte LE number depicting the slice's length.
              const view = new DataView(buffer.buffer, bytes + i * 16, 16);
              hasher.update(slice(view.getUint32(0, true), view.getUint32(8, true)));
            }

            buffer.set(hasher.digest(), result_ptr);
            return BigInt(0);
          },
          sol_invoke_signed_c: (_instruction: any, _account_infos: any, _account_infos_len: any, _signer_seeds: any, _signer_seeds_len: any) => {
            return BigInt(0);
          },
          sol_alloc_free_: (size: BigInt, ptr: number) => {

          }
        }
      });

      console.log("AFTER");

      const tests = Object.entries(instance.exports).filter(([key,]) => key.startsWith("test_"));

      let count = 1;
      for (const [testName, testFunction] of tests) {
        const formattedTestName = testName.substring("test_".length).replace("__", "::");

        try {
          // @ts-ignore
          testFunction();
          log.write("compiler", `\u001b[32m[${count}/${tests.length}] ${formattedTestName} ✓ success!\u001b[0m\n`);
        } catch (err) {
          // @ts-ignore
          log.write("compiler", `\u001b[31m[${count}/${tests.length}] ${formattedTestName} ✗ failed\u001b[0m\n\n${err.stack}`);
        }

        count += 1;
      }
    } catch (err) {
      console.error(err);
    }

    sync();
  }, [log, editor, fs, sync, llvm, compiler, sysrootLoaded]);

  const handleTrashLogsClicked = useCallback((scope: string) => {
    log.clear(scope);
  }, [log]);

  const handleSaveLogsClicked = useCallback((scope: string) => {
    const logs = log.get(scope) ?? [];
    if (logs.length === 0) return;
    saveAs(new Blob([JSON.stringify(logs)]), `${scope}_logs.txt`);
  }, [log]);

  const [importModalIsOpened, setImportModalIsOpened] = useState(false);
  const [importUrl, setImportUrl] = useState("");

  const modalStyles = {
    overlay: {
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    }
  };

  const handleImportSourceArchiveClicked = useCallback(async () => {
    if (!fs) {
      return;
    }

    const url = importUrl;
    setImportModalIsOpened(false);
    setImportUrl("");

    log.write("alon", `Downloading ZIP archive from '${url}'...`);

    const blob = await (await fetch(`https://cors.bridged.cc/${url}`, {
      headers: {
        "x-cors-grida-api-key": "7a571699-418f-4f84-83b8-51393c448c40",
      }
    })).blob();

    log.write("alon", "Unpacking ZIP archive...");

    const reader = new zip.ZipReader(new zip.BlobReader(blob));
    const entries = await reader.getEntries();

    const recursiveDelete = (node: any) => {
      const path = fs.getPath(node);
      const model = monaco.editor.getModels().find(model => model.uri.path === path);
      if (model) {
        model.dispose();
      }

      if (node.isFolder) {
        Object.values(node.contents).forEach(recursiveDelete);
        fs.rmdir(path);
      } else {
        fs.unlink(path);
      }
    };

    const result = fs.lookupPath("/project", {});
    Object.values((result.node as any).contents).forEach(recursiveDelete);

    for (const entry of entries) {
      const path = "/project/" + entry.filename.slice(entry.filename.indexOf("/") + 1);
      if (entry.directory) {
        try { fs.mkdir(path); } catch { }
        continue;
      }

      const bytes = await entry.getData!(new zip.Uint8ArrayWriter());
      fs.writeFile(path, bytes);

      log.write("alon", `Unpacked source archive file '${path}'.`);
    }

    await reader.close();

    log.write("alon", "Source ZIP archive unpacked.");
    sync();
  }, [fs, log, importUrl, setImportUrl, sync]);

  const { connection } = useConnection();
  const { publicKey } = useWallet();

  const handleClickAirdrop = useCallback(async () => {
    if (!connection || !publicKey) {
      return;
    }

    log.write("alon", `Requesting an airdrop for 1 SOL to <a class="underline text-gray-700" href="https://explorer.solana.com/address/${publicKey.toBase58()}?cluster=devnet">${publicKey.toBase58()}</a>.`);

    try {
      const transactionId = await connection.requestAirdrop(publicKey, 1 * web3.LAMPORTS_PER_SOL);
      log.write("alon", `Waiting for the airdrop transaction for 1 SOL to be fully confirmed. Transaction ID: <a class="underline text-gray-700" href="https://explorer.solana.com/tx/${transactionId}?cluster=devnet">${transactionId}</a>`)
      await connection.confirmTransaction(transactionId);
      log.write("alon", `Airdrop transaction <a class="underline text-gray-700" href="https://explorer.solana.com/tx/${transactionId}?cluster=devnet">${transactionId}</a> has been fully confirmed.`);
    } catch (err) {
      // @ts-ignore
      log.write("alon", `An error occurred while attempting to airdrop 1 SOL to <a class="underline text-gray-700" href="https://explorer.solana.com/address/${publicKey.toBase58()}?cluster=devnet">${publicKey.toBase58()}</a>.\n\n${err.stack}`)
    }
  }, [log, connection, publicKey]);

  const [autoRunTests, setAutoRunTests] = useState(false);
  const autoRunTestTimeoutHandle = useRef<number | null>(null);
  const isMounted = useMountedState();

  const handleChangeCode = useCallback((newCode: string, event: monaco.editor.IModelContentChangedEvent) => {
    if (!fs || !editor || !parser) {
      return;
    }

    const model = editor.getModel();
    if (!model) {
      return;
    }

    fs.writeFile(model.uri.path, newCode);

    if (autoRunTests) {
      if (autoRunTestTimeoutHandle.current) {
        clearTimeout(autoRunTestTimeoutHandle.current);
      }
      autoRunTestTimeoutHandle.current = setTimeout(() => {
        if (isMounted()) {
          handleClickRunTests();
        }
      }, 250) as any;
    }

    if (!tree) {
      const newTree = parser.parse(newCode);
      markEditorErrors(newTree, editor);
      setTree(newTree);
      return;
    }

    if (event.changes.length > 0) {
      for (const change of event.changes) {
        const startIndex = change.rangeOffset;
        const oldEndIndex = change.rangeOffset + change.rangeLength;
        const newEndIndex = change.rangeOffset + change.text.length;
        const startPosition = editor.getModel()!.getPositionAt(startIndex);
        const oldEndPosition = editor.getModel()!.getPositionAt(oldEndIndex);
        const newEndPosition = editor.getModel()!.getPositionAt(newEndIndex);
        tree.edit({
          startIndex,
          oldEndIndex,
          newEndIndex,
          startPosition: { row: startPosition.lineNumber, column: startPosition.column },
          oldEndPosition: { row: oldEndPosition.lineNumber, column: oldEndPosition.column },
          newEndPosition: { row: newEndPosition.lineNumber, column: newEndPosition.column },
        });
      }

      const newTree = parser.parse(newCode, tree);
      markEditorErrors(newTree, editor);
      setTree(newTree);
    }
  }, [fs, editor, parser, tree, autoRunTests, handleClickRunTests, isMounted]);

  return (
    <>
      <div className="font-mono antialiased grid grid-flow-row auto-rows-min-auto w-full h-full max-h-full">
        <div className=" bg-gray-200 border-b">
          <div className="flex">
            <button className={`bg-gray-100 px-2 py-1 text-xs border-r text-center flex whitespace-nowrap gap-2 ${sysrootLoaded && !compilation.loading && !testRunner.loading ? "hover:bg-gray-300" : "animate-pulse bg-gray-200 cursor-default"}`} disabled={!sysrootLoaded || compilation.loading || testRunner.loading} onClick={handleClickCompile}>
              Compile
              <span className="text-gray-600">(F1)</span>
            </button>

            <button className={`bg-gray-100 px-2 py-1 text-xs border-r text-center flex whitespace-nowrap gap-2 ${sysrootLoaded && !compilation.loading && !testRunner.loading ? "hover:bg-gray-300" : "animate-pulse bg-gray-200 cursor-default"}`} disabled={!sysrootLoaded || compilation.loading || testRunner.loading} onClick={handleClickRunTests}>
              Run Tests
              <span className="text-gray-600">(F2)</span>
            </button>

            <div className={`bg-gray-100 px-2 py-1 text-xs border-r text-center flex whitespace-nowrap gap-2 ${sysrootLoaded && !compilation.loading ? "hover:bg-gray-300" : "bg-gray-200 cursor-default"}`}>
              <input type="checkbox" disabled={!sysrootLoaded || compilation.loading} checked={autoRunTests} onChange={() => setAutoRunTests(checked => !checked)} />
              <label>Auto-run Tests</label>
              <span className="text-gray-600">(F3)</span>
            </div>

            <button className={`bg-gray-100 px-2 py-1 text-xs border-r text-center flex whitespace-nowrap gap-2 ${connection && publicKey ? "hover:bg-gray-300" : "bg-gray-200 cursor-default"}`} disabled={!connection || !publicKey} onClick={handleClickAirdrop}>
              Airdrop 1 SOL
              <span className="text-gray-600">(F4)</span>
            </button>
          </div>
        </div>
        <div className="w-full h-full grid grid-flow-col auto-cols-min-auto">
          <div className="border-r p-4 flex flex-col gap-4" style={{ width: "24rem" }}>
            <p className="text-2xl leading-7 font-bold">Alon</p>

            <SlotInfo />

            <WalletButton className="w-full" />

            <div>
              <TokenAccounts />
            </div>

            <div className="flex flex-col h-full">
              <div className="flex-grow-0 font-lg leading-6 mb-1 flex justify-between">
                Files
                <button onClick={() => setImportModalIsOpened(true)} disabled={!sysrootLoaded} className={`${!sysrootLoaded ? `cursor-default` : ``}`}>
                  <UploadIcon className={`w-5 h-5 p-0.5 bg-gray-100 rounded-lg ${!sysrootLoaded ? `text-gray-400` : `hover:bg-gray-300`}`} />
                </button>
              </div>

              <div className={`relative flex-grow border text-xs overflow-y-auto scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200 ${sysrootLoaded ? "" : "animate-pulse"}`}>
                <TreeProvider data={files} getName={getFileName} getChildren={getFileChildren} onClicked={handleFileClicked}>
                  <Tree<any> className="absolute top-0 left-0 bottom-0 right-0" />
                </TreeProvider>
              </div>
            </div>
          </div>
          <div className={`w-full h-full flex flex-col ${sysrootLoaded ? "" : "animate-pulse"}`}>
            <Tabs editor={editor} />
            <div className={`w-full h-full bg-gray-100 ${sysrootLoaded ? "" : "animate-pulse"}`}>
              <ResponsiveMonacoEditor
                options={{
                  fontSize: 12,
                  padding: {
                    top: 16,
                  },
                  model: null,
                }}
                editorDidMount={handleEditorMount}
                onChange={handleChangeCode}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1 border-l" style={{ width: "36rem" }}>
            <div className="border-b flex-grow flex flex-col">
              <div className="px-2 py-1 text-sm font-medium flex justify-between items-center">
                Compiler Logs
                <div className="flex gap-1">
                  <button>
                    <SaveIcon className="w-5 h-5 p-0.5 bg-gray-100 hover:bg-gray-300 rounded-lg" onClick={() => handleSaveLogsClicked("compiler")} />
                  </button>
                  <button>
                    <TrashIcon className="w-5 h-5 p-0.5 bg-gray-100 hover:bg-gray-300 rounded-lg" onClick={() => handleTrashLogsClicked("compiler")} />
                  </button>

                </div>
              </div>
              <Console scope="compiler" />
            </div>
            <div className="border-b flex-grow flex flex-col">
              <div className="px-2 py-1 text-sm font-medium flex justify-between items-center">
                Alon Logs
                <div className="flex gap-1">
                  <button>
                    <SaveIcon className="w-5 h-5 p-0.5 bg-gray-100 hover:bg-gray-300 rounded-lg" onClick={() => handleSaveLogsClicked("alon")} />
                  </button>
                  <button>
                    <TrashIcon className="w-5 h-5 p-0.5 bg-gray-100 hover:bg-gray-300 rounded-lg" onClick={() => handleTrashLogsClicked("alon")} />
                  </button>
                </div>
              </div>
              <Console scope="alon" />
            </div>
          </div>
        </div>
      </div >
      <Modal isOpen={importModalIsOpened} onRequestClose={() => setImportModalIsOpened(false)} style={modalStyles} className="font-mono">
        <div className="p-4 py-6 flex flex-col gap-2 m-auto bg-white w-96">
          <div className="py-2 break-words">
            Provide a link to a ZIP archive containing your source files.
          </div>
          <div className="flex flex-col gap-4">
            <input
              type="url"
              className="p-2 border"
              placeholder="https://github.com/lithdew/alon-sysroot/archive/refs/heads/master.zip"
              value={importUrl}
              onChange={(event) => setImportUrl(event.target.value)}
            />
            <div>
              <button className="flex w-full" onClick={handleImportSourceArchiveClicked}>
                <span className="rounded px-4 py-1 bg-gray-900 hover:bg-gray-700 text-white appearance-none shadow-lg w-full">Import</span>
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default App;
