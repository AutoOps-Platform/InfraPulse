# Linux/amd64 child manifest, not the multi-platform index.
FROM node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS build
WORKDIR /app
ENV CI=true PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN npm install --global --ignore-scripts pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma/ ./prisma/
COPY prisma.config.ts nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN pnpm db:generate && pnpm build
# Extract the installed, lock-verified production closure. pnpm --prod retains
# Prisma's optional CLI/TypeScript peers; those are not runtime dependencies.
# Preserve pnpm's relative links, but omit optional peers and all dev roots.
RUN node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const source='/app/node_modules', destination='/prod/node_modules';
const included=new Set(), holders=new Set();
fs.mkdirSync(destination,{recursive:true});
function locate(from,name,optional=false){
  for(const base of createRequire(from).resolve.paths(name)??[]){
    const candidate=path.join(base,name,'package.json');
    if(fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate));
  }
  if(!optional) throw new Error('Required locked runtime package missing.');
}
function include(directory){
  if(included.has(directory)) return;
  included.add(directory);
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  const relative=path.relative(source,directory);
  if(!relative.startsWith('.pnpm/')) throw new Error('Unexpected dependency layout.');
  const holder=relative.split('/').slice(0,3).join('/');
  if(!holders.has(holder)){
    holders.add(holder);
    fs.cpSync(path.join(source,holder),path.join(destination,holder),{recursive:true,dereference:false,verbatimSymlinks:true});
  }
  for(const name of Object.keys(manifest.dependencies??{})) include(locate(path.join(directory,'package.json'),name));
  for(const name of Object.keys(manifest.optionalDependencies??{})){
    const dependency=locate(path.join(directory,'package.json'),name,true); if(dependency) include(dependency);
  }
  for(const name of Object.keys(manifest.peerDependencies??{})){
    if(!manifest.peerDependenciesMeta?.[name]?.optional) include(locate(path.join(directory,'package.json'),name));
  }
}
for(const name of Object.keys(JSON.parse(fs.readFileSync('/app/package.json','utf8')).dependencies)){
  const directory=locate('/app/package.json',name); include(directory);
  const link=path.join(destination,name), target=path.join(destination,path.relative(source,directory));
  fs.mkdirSync(path.dirname(link),{recursive:true}); fs.symlinkSync(path.relative(path.dirname(link),target),link);
}
JS

FROM build AS test
COPY scripts/ ./scripts/
COPY test/ ./test/
COPY vitest.config.ts vitest.config.integration.ts vitest.config.e2e.ts ./
CMD ["pnpm", "test"]

# Explicit operator-only tooling. No operation runs during the image build.
FROM build AS migrate
COPY scripts/ ./scripts/
RUN groupadd --gid 10002 management && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin management
USER 10002:10002
CMD ["node", "scripts/migrate-db.ts"]

# Default: single process; no source, tests, operations or development CLI.
FROM node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS runtime
# These exact image-owned paths were verified in the pinned base. Keep package
# managers in build/test/migrate only, not even as dormant runtime CLIs.
RUN rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && groupadd --gid 10002 management && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin management
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER 10002:10002
EXPOSE 3000
CMD ["node", "dist/main.js"]
