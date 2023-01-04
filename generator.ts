import { cli } from "https://deno.land/x/cobra@v0.0.9/mod.ts";
import {
  basename,
  extname,
  join,
} from "https://deno.land/std@0.168.0/path/mod.ts";

let clobber = false;
const root = cli({
  use: "generate [--proto protobuf] [--out dir]",
  short: "generates service api stubs",
  run: async (_cmd, _args, flags) => {
    // dir where generation happens
    const outDir = flags.value<string>("out");
    // capture whether we can 'regenerate'
    clobber = flags.value<boolean>("force");
    // the proto file
    const protoPath = flags.value<string>("proto");
    if (protoPath === "") {
      throw new Error("--proto is required");
    }
    const protoName = basename(protoPath);
    const ext = extname(protoName);
    // this will be the name of the generated library without the extension
    const genLib = protoName.substring(0, protoName.length - ext.length);
    // process the protobuf definition if it parses then we create artifacts
    const services = await parseProto(protoPath);
    if (await exists(outDir)) {
      if (!clobber) {
        throw new Error(`${outDir} exists --force to overwrite`);
      }
    } else {
      await Deno.mkdir(outDir);
    }
    // copy the protobuf file
    await copy(protoPath, join(outDir, basename(protoPath)));
    // the file could contain multiple services each with multiple handlers
    // we create a NATS service per service
    for (const s of services) {
      const handlersPath = join(outDir, `${s.name}_handlers.ts`);
      if (await exists(handlersPath) && clobber) {
        const bak = join(outDir, `${s.name.toLowerCase()}_handlers.bak`);
        await copy(handlersPath, bak);
        console.log(
            `${handlersPath} was backed up to ${bak} - subsequent runs will destroy the backup!`,
        );
      }
      await generateHandlers(outDir, s, genLib);
      await generateMain(outDir, s, genLib);
      await generateClient(outDir, s, genLib);
    }
    // for now this is a nodejs only, so we need a package.json and tsconfig
    await generateNodePackage(join(outDir, "package.json"), protoPath);
    await generateTscConfig(join(outDir, "tsconfig.json"));

    console.log(`edit handlers path and run 'npm run build' to build`);
    return Promise.resolve(0);
  },
});

root.addFlag({
  short: "p",
  name: "proto",
  type: "string",
  usage: "filepath to the protobuf file",
  required: true,
});

root.addFlag({
  short: "o",
  name: "out",
  type: "string",
  usage: "filepath to the directory where files will be generated",
  value: "./generated",
});

root.addFlag({
  short: "f",
  name: "force",
  type: "boolean",
  usage: "clobber any existing assets",
  value: false,
});

type ServiceParse = {
  name: string;
  rpcs: ServiceRpc[];
};

type ServiceRpc = {
  name: string;
  inType: string;
  outType: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    throw err;
  }
}

async function save(filePath: string, data: string) {
  await Deno.writeTextFile(filePath, data);
}

async function saveJSON(filePath: string, data: unknown) {
  await save(filePath, JSON.stringify(data, undefined, " "));
}

async function copy(pathA: string, pathB: string) {
  const d = await Deno.readTextFile(pathA);
  await save(pathB, d);
}

function generateImports(
  services: ServiceRpc[],
  protoLibName: string,
): string {
  const a: string[] = [];
  services.forEach((s) => {
    a.push(s.outType, s.inType);
  });
  const types = a.filter((e, idx) => {
    return a.indexOf(e) === idx;
  });
  const protoImports = `import {${
    types.sort().join(", ")
  }} from "./${protoLibName}.js";`;

  return [protoImports].join("\n");
}

function generateHandler(h: ServiceRpc): string {
  return `export function ${h.name}Handler(r: ${h.inType}): Promise<${h.outType}>{
  // add your code here
  return Promise.reject(new Error("not implemented"));
}\n`;
}

function generateHandlerImport(
  name: string,
  parse: ServiceRpc[],
): string {
  const handlers = parse.map((p) => {
    return `${p.name}Handler`;
  });
  return `import {${
    handlers.join(", ")
  }} from "./${name.toLowerCase()}_handlers.js";`;
}

function createService(service: ServiceParse): string {
  return `  
const nc = await connect();
const srv = await nc.services.add({
  name: "${service.name}",
  version: "0.0.1",
  endpoint: {
    subject: "${service.name}",
    handler: null
  }
});

srv.stopped.then((err) => {
  console.log("service stopped:", err?.message);
});
`;
}

function addEndpoint(h: ServiceRpc): string {
  return `
srv.addEndpoint("${h.name}", (err, m) => {
  // if we get an error from the subscription, stop
  if(err) {
    srv.stop(err);
    return;
  }
  const input = ${h.inType}.decode(m?.data);
  ${h.name}Handler(input)
    .then((o) => { 
      m.respond(${h.outType}.encode(o).finish())
    })
    .catch((err) => { 
      m.respondError(500, err.message); 
    });
});
`;
}

async function generateHandlers(
  fn: string,
  service: ServiceParse,
  genLibPath: string,
) {
  const sections: string[] = ["// edit your services here"];
  sections.push(generateImports(service.rpcs, genLibPath));
  service.rpcs.forEach((h) => {
    sections.push(generateHandler(h));
  });
  await save(
    join(fn, `${service.name.toLowerCase()}_handlers.ts`),
    sections.join("\n"),
  );
}

async function generateMain(
  dir: string,
  srv: ServiceParse,
  genLibPath: string,
) {
  const sections: string[] = [`
// This file implements the NATS service portion of your service.
// The handlers for the various operations are defined in
// ${srv.name.toLowerCase()}_handlers.ts file.
// To build the service run: 'npm run generate'
// To start the service do: 'node ${srv.name.toLowerCase()}_service.js' 
// 
// THE CONTENTS OF FILE IS GENERATED AND SHOULDN'T BE EDITED
// THIS TECHNOLOGY IS EXPERIMENTAL USE AT YOUR OWN RISK
`];
  sections.push(generateHandlerImport(srv.name, srv.rpcs));
  sections.push(generateImports(srv.rpcs, genLibPath));
  sections.push(`import { connect, ServiceError } from "nats";`);
  sections.push(createService(srv));
  srv.rpcs.forEach((fn) => {
    sections.push(addEndpoint(fn));
  });
  await save(
    join(dir, `${srv.name.toLowerCase()}_service.ts`),
    sections.join("\n"),
  );
}

async function generateNodePackage(filePath: string, protoPath: string) {
  const pkg = {
    name: `service`,
    version: "1.0.0",
    description: "",
    main: "index.js",
    type: "module",
    scripts: {
      build:
        `protoc --plugin=./node_modules/.bin/protoc-gen-ts_proto --ts_proto_opt=importSuffix=.js --ts_proto_opt=esModuleInterop=true --ts_proto_out=. ./${
          basename(protoPath)
        } && tsc`,
      test: 'echo "Error: no test specified" && exit 1',
    },
    dependencies: {
      "ts-proto": "^1.137.0",
      typescript: "^4.9.4",
    },
    keywords: [],
    author: "",
    license: "ISC",
  };
  await saveJSON(filePath, pkg);
}

async function generateTscConfig(filePath: string) {
  const config = {
    compilerOptions: {
      target: "esnext",
      lib: [],
      module: "esnext",
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      strict: true,
      moduleResolution: "node",
      skipLibCheck: true,
    },
  };
  await saveJSON(filePath, config);
}

async function generateClient(outDir: string, srv: ServiceParse, protoLibName: string): Promise<void> {
  const parts: string[] = [];
  parts.push(`// THE CONTENTS OF FILE IS GENERATED AND SHOULDN'T BE EDITED
// THIS TECHNOLOGY IS EXPERIMENTAL USE AT YOUR OWN RISK
`);
  parts.push(generateImports(srv.rpcs, protoLibName));
  parts.push(`import { NatsConnection, ServiceError } from "nats"`);
  parts.push(`
export class ${srv.name}Client {
  nc: NatsConnection;
  constructor(nc: NatsConnection) {
    this.nc = nc;
  }  
`);

  srv.rpcs.forEach((rpc) => {
    parts.push(`  async ${rpc.name}(data: ${rpc.inType}): Promise<${rpc.outType}> {
    const r = await this.nc.request("${srv.name}.${rpc.name}", ${rpc.inType}.encode(data).finish());
    return ${rpc.outType}.decode(r.data);
  }  
`);
  });
 parts.push(`}`)

  await save(join(outDir, `${srv.name.toLowerCase()}_client.ts`), parts.join("\n"));
}

async function parseProto(filePath: string): Promise<ServiceParse[]> {
  const proto = await Deno.readTextFile(filePath);

  // service definitions regex
  const servicesRE = /service\s+(\w+)([\s\S]*?)}\n}/mg;

  const services = [];
  let m;
  // look for one or more 'service'
  while ((m = servicesRE.exec(proto)) !== null) {
    const name = m?.[1];
    // RPC regex
    const rpcRE = /rpc\s+(\w+)\((\S+)\)\s+returns\s+\((\S+)\)\s+\{}/g;
    const lines = m?.[0].match(rpcRE);
    if (lines === null) {
      throw new Error("expected rpc entries like `rpc fn(T) returns (T) {}`");
    }
    // for each rpc, capture the name and input/output types
    const rpcs = lines.map((line: string) => {
      const rpcLineRE = /rpc\s+(\w+)\((\S+)\)\s+returns\s+\((\S+)\)\s+\{}/m;
      const m = line.match(rpcLineRE);
      return {
        name: m?.[1],
        inType: m?.[2],
        outType: m?.[3],
      } as ServiceRpc;
    });

    services.push({ name, rpcs });
  }
  return services;
}

Deno.exit(await root.execute(Deno.args));
