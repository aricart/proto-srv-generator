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
    const parse = await parseProto(protoPath);
    if (await exists(outDir)) {
      if (!clobber) {
        throw new Error(`${outDir} exists --force to overwrite`);
      }
    } else {
      await Deno.mkdir(outDir)
        .catch((err) => {
          console.error(`failed to create ${outDir}: ${err.message}`);
          throw err;
        });
    }
    // copy the protobuf file
    await copy(protoPath, join(outDir, basename(protoPath)));
    // the file could contain multiple services each with multiple handlers
    // we create a NATS service per service
    for (const s of parse.services) {
      const handlersPath = join(outDir, `${s.name}_handlers.ts`);
      if (await exists(handlersPath) && clobber) {
        const bak = join(outDir, `${s.name.toLowerCase()}_handlers.bak`);
        await copy(handlersPath, bak);
        console.log(
          `${handlersPath} was backed up to ${bak} - subsequent runs will destroy the backup!`,
        );
      }
      await generateStubs(outDir, s, genLib);
    }
    await generateMain(outDir, parse, genLib);
    await generateClient(outDir, parse, genLib);

    // for now this is a nodejs only, so we need a package.json and tsconfig
    await generateNodePackage(join(outDir, "package.json"), protoPath);
    await generateTscConfig(join(outDir, "tsconfig.json"));

    console.log(`'npm install', edit handlers path, 'npm run build'`);
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

type ProtoParse = {
  packageName: string;
  services: ProtoService[];
};

type ProtoService = {
  name: string;
  rpcs: ProtoRpc[];
};

type ProtoRpc = {
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

function generateImport(types: string[], protoLibName: string): string {
  types = types.filter((e, idx) => {
    return types.indexOf(e) === idx;
  });
  return `import { ${types.sort().join(", ")} } from "./${protoLibName}.js";`;
}

function generateServiceImports(
  srv: ProtoService,
  protoLibName: string,
): string {
  const a: string[] = [];
  srv.rpcs.forEach((r) => {
    a.push(r.outType, r.inType);
  });
  return generateImport(a, protoLibName);
}

function generateAllProtoImports(
  parse: ProtoParse,
  protoLibName: string,
): string {
  const a: string[] = [];
  parse.services.forEach((s) => {
    s.rpcs.forEach((r) => {
      a.push(r.outType, r.inType);
    });
  });
  return generateImport(a, protoLibName);
}

function generateHandler(h: ProtoRpc): string {
  return `
    export function ${h.name}Handler(r: ${h.inType}): Promise<${h.outType}>{
        // add your code here
        return Promise.reject(new Error("not implemented"));
    }
`;
}

function generateHandlerImport(
  fn: string,
  parse: ProtoService,
): string {
  return `import { ${parse.name} } from "./${fn.toLowerCase()}_handlers.js";`;
}

function createService(srv: ProtoParse): string {
  return `const nc = await connect();
const srv = await nc.services.add({
  name: "${srv.packageName}",
  version: "0.0.1",
});

srv.stopped.then((err) => {
  console.log("service stopped:", err?.message);
});
`;
}

function addEndpoint(srv: ProtoService, h: ProtoRpc): string {
  return `${srv.name.toLowerCase()}.addEndpoint("${h.name}", (err, m) => {
  // if we get an error from the subscription, stop
  if(err) {
    srv.stop(err);
    return;
  }
  const input = ${h.inType}.decode(m?.data);
  ${srv.name}.${h.name}Handler(input)
    .then((o) => {
      m.respond(${h.outType}.encode(o).finish())
    })
    .catch((err) => {
      m.respondError(500, err.message);
    });
});
`;
}

async function generateStubs(
  fn: string,
  service: ProtoService,
  genLibPath: string,
) {
  const sections: string[] = ["// edit your services here"];
  sections.push(generateServiceImports(service, genLibPath));
  sections.push(`export namespace ${service.name} {`);
  service.rpcs.forEach((h) => {
    sections.push(generateHandler(h));
  });
  sections.push(`}`);
  await save(
    join(fn, `${service.name.toLowerCase()}_handlers.ts`),
    sections.join("\n"),
  );
}

async function generateMain(
  dir: string,
  parse: ProtoParse,
  genLibPath: string,
) {
  const sections: string[] = [`
// This file implements the NATS service portion of your service.
// The handlers for the various operations are defined in
// <service>_handlers.ts file.
// To build the service run: 'npm run generate'
// To start the service do: 'node ${parse.packageName.toLowerCase()}_service.js'
//
// THE CONTENTS OF FILE IS GENERATED AND SHOULDN'T BE EDITED
// THIS TECHNOLOGY IS EXPERIMENTAL USE AT YOUR OWN RISK
`];
  sections.push(`import { connect, ServiceError } from "nats";`);

  sections.push(generateAllProtoImports(parse, genLibPath));

  parse.services.forEach((srv) => {
    sections.push(generateHandlerImport(srv.name, srv));
  });

  sections.push(createService(parse));

  parse.services.forEach((srv) => {
    sections.push(
      `const ${srv.name.toLowerCase()} = srv.addGroup("${srv.name}");`,
    );
    srv.rpcs.forEach((rpc) => {
      sections.push(addEndpoint(srv, rpc));
    });
  });

  await save(
    join(dir, `${parse.packageName.toLowerCase()}_service.ts`),
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
      "nats": "^2.13.1",
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

async function generateClient(
  outDir: string,
  parse: ProtoParse,
  protoLibName: string,
): Promise<void> {
  const parts: string[] = [];
  parts.push(`// THE CONTENTS OF FILE IS GENERATED AND SHOULDN'T BE EDITED
// THIS TECHNOLOGY IS EXPERIMENTAL USE AT YOUR OWN RISK
`);
  parts.push(generateAllProtoImports(parse, protoLibName));
  parts.push(`import { NatsConnection, ServiceError } from "nats"`);

  parse.services.forEach((srv) => {
    parts.push(`
export class ${srv.name}Client {
  nc: NatsConnection;
  constructor(nc: NatsConnection) {
    this.nc = nc;
  }
`);
    srv.rpcs.forEach((rpc) => {
      parts.push(
        `  async ${rpc.name}(data: ${rpc.inType}): Promise<${rpc.outType}> {
    const r = await this.nc.request("${srv.name}.${rpc.name}", ${rpc.inType}.encode(data).finish());
    return ${rpc.outType}.decode(r.data);
  }
`,
      );
    });
    parts.push(`}`);
  });

  await save(
    join(outDir, `${parse.packageName.toLowerCase()}_clients.ts`),
    parts.join("\n"),
  );
}

async function parseProto(filePath: string): Promise<ProtoParse> {
  const proto = await Deno.readTextFile(filePath);
  const r = { packageName: "", services: [] } as ProtoParse;

  // package regex
  const packageRE = /package\s+(\w+)([\s\S]*?)/;
  let m = packageRE.exec(proto);
  if (m) {
    r.packageName = m[1];
  }

  // service definitions regex
  const servicesRE = /service\s+(\w+)([\s\S]*?)}\n}/mg;

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
      } as ProtoRpc;
    });
    if (r.packageName === "") {
      r.packageName = r.services?.[0].name;
    }
    r.services.push({ name, rpcs });
  }
  return r;
}

Deno.exit(await root.execute(Deno.args));
