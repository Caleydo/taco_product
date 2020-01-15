/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

const Promise = require('bluebird');
const path = require('path');
const fs = Promise.promisifyAll(require('fs-extra'));
const chalk = require('chalk');
const pkg = require('./package.json');
// see show help
const argv = require('yargs-parser')(process.argv.slice(2));

const quiet = argv.quiet !== undefined;

const now = new Date();
const prefix = (n) => n < 10 ? ('0' + n) : n.toString();
const buildId = `${now.getUTCFullYear()}${prefix(now.getUTCMonth())}${prefix(now.getUTCDate())}-${prefix(now.getUTCHours())}${prefix(now.getUTCMinutes())}${prefix(now.getUTCSeconds())}`;
pkg.version = pkg.version.replace('SNAPSHOT', buildId);
const env = Object.assign({}, process.env);
const productName = pkg.name.replace('_product', '');

function showHelp(steps, chain) {
  console.info(`node build.js <options> -- step1 step2
possible options:
 * --quiet         ... reduce log messages
 * --serial        ... build elements sequentially
 * --skipTests     ... skip tests
 * --injectVersion ... injects the product version into the package.json of the built component
 * --useSSH        ... clone via ssh instead of https
 * --skipCleanUp   ... skip cleaning up old docker images
 * --skipSaveImage ... skip saving the generated docker images
 * --pushTo        ... push docker images to the given registry
 * --noDefaultTags ... don't push generated default tag :<timestamp>
 * --pushExtra     ... push additional custom tag: e.g., --pushExtra=develop
 * --forceLabel    ... force to use the label even only a single service exists
 * --dryRun        ... just compute chain no execution
 * --help          ... show this help message

arguments: (starting with --!) optional list of steps to execute in the given order (expert mode) by default the default chain is executed
 `);

  steps = Object.keys(steps);
  const primary = steps.filter((d) => !d.includes(':')).sort((a, b) => a.localeCompare(b));
  const secondary = steps.filter((d) => d.includes(':')).sort((a, b) => a.localeCompare(b));

  console.info('possible primary steps:\n ', primary.join('\n  '));
  console.info('possible secondary steps:\n ', secondary.join('\n  '));

  console.info('default chain:\n', JSON.stringify(chain, null, ' '));
}

/**
 * generates a repo url to clone depending on the argv.useSSH option
 * @param {string} url the repo url either in git@ for https:// form
 * @returns the clean repo url
 */
function toRepoUrl(url) {
  if (url.startsWith('git@')) {
    if (argv.useSSH) {
      return url;
    }
    // have an ssh url need an http url
    const m = url.match(/(https?:\/\/([^/]+)\/|git@(.+):)([\w\d-_/]+)(.git)?/);
    return `https://${m[3]}/${m[4]}.git`;
  }
  if (url.startsWith('http')) {
    if (!argv.useSSH) {
      return url;
    }
    // have a http url need an ssh url
    const m = url.match(/(https?:\/\/([^/]+)\/|git@(.+):)([\w\d-_/]+)(.git)?/);
    return `git@${m[2]}:${m[4]}.git`;
  }
  if (!url.includes('/')) {
    url = `Caleydo/${url}`;
  }
  if (argv.useSSH) {
    return `git@github.com:${url}.git`;
  }
  return `https://github.com/${url}.git`;
}

/**
 * guesses the credentials environment variable based on the given repository hostname
 * @param {string} repo
 */
function guessUserName(repo) {
  // extract the host
  const host = repo.match(/:\/\/([^/]+)/)[1];
  const hostClean = host.replace(/\./g, '_').toUpperCase();
  // e.g. GITHUB_COM_CREDENTIALS
  const envVar = process.env[`${hostClean}_CREDENTIALS`];
  if (envVar) {
    return envVar;
  }
  return process.env.PHOVEA_GITHUB_CREDENTIALS;
}

function toRepoUrlWithUser(url) {
  const repo = toRepoUrl(url);
  if (repo.startsWith('git@')) { // ssh
    return repo;
  }
  const usernameAndPassword = guessUserName(repo);
  if (!usernameAndPassword) { // ssh or no user given
    return repo;
  }
  return repo.replace('://', `://${usernameAndPassword}@`);
}

function fromRepoUrl(url) {
  if (url.includes('.git')) {
    return url.match(/\/([^/]+)\.git/)[0];
  }
  return url.slice(url.lastIndexOf('/') + 1);
}

/**
 * deep merge with array union
 * @param {*} target
 * @param {*} source
 */
function mergeWith(target, source) {
  const _ = require('lodash');
  const mergeArrayUnion = (a, b) => Array.isArray(a) ? _.union(a, b) : undefined;
  _.mergeWith(target, source, mergeArrayUnion);
  return target;
}

function downloadDataUrl(url, dest) {
  if (!url.startsWith('http')) {
    url = `https://s3.eu-central-1.amazonaws.com/phovea-data-packages/${url}`;
  }
  const http = require(url.startsWith('https') ? 'https' : 'http');
  console.log(chalk.blue('download file', url));
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    http.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', reject);
  });
}

function toDownloadName(url) {
  if (!url.startsWith('http')) {
    return url;
  }
  return url.substring(url.lastIndexOf('/') + 1);
}

function downloadDataFile(desc, destDir, cwd) {
  if (typeof desc === 'string') {
    desc = {
      type: 'url',
      url: desc
    };
  }
  desc.type = desc.type || (desc.url ? 'url' : (desc.repo ? 'repo' : 'unknown'));
  switch (desc.type) {
    case 'url': {
      desc.name = desc.name || toDownloadName(desc.url);
      return fs.ensureDirAsync(destDir).then(() => downloadDataUrl(desc.url, `${destDir}/${desc.name}`));
    }
    case 'repo': {
      desc.name = desc.name || fromRepoUrl(desc.repo);
      let downloaded;
      if (fs.existsSync(path.join(cwd, desc.name))) {
        downloaded = Promise.resolve(desc);
      } else {
        downloaded = cloneRepo(desc, cwd);
      }
      return downloaded.then(() => fs.copyAsync(`${cwd}/${desc.name}/data`, `${destDir}/${desc.name}`));
    }
    default:
      console.error('unknown data type:', desc.type);
      return null;
  }
}

/**
 * spawns a child process
 * @param cmd command as array
 * @param args arguments
 * @param opts options
 * @returns a promise with the result code or a reject with the error string
 */
function spawn(cmd, args, opts) {
  const spawn = require('child_process').spawn;
  const _ = require('lodash');
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, typeof args === 'string' ? args.split(' ') : args, _.merge({stdio: argv.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 1, 2]}, opts));
    const out = [];
    if (p.stdout) {
      p.stdout.on('data', (chunk) => out.push(chunk));
    }
    if (p.stderr) {
      p.stderr.on('data', (chunk) => out.push(chunk));
    }
    p.on('close', (code, signal) => {
      if (code === 0) {
        console.info(cmd, 'ok status code', code, signal);
        resolve(code);
      } else {
        console.error(cmd, 'status code', code, signal);
        if (args.quiet) {
          // log output what has been captured
          console.log(out.join('\n'));
        }
        reject(new Error(`${cmd} failed with status code ${code} ${signal}`));
      }
    });
  });
}

/**
 * run npm with the given args
 * @param cwd working directory
 * @param cmd the command to execute as a string
 * @return {*}
 */
function npm(cwd, cmd) {
  console.log(cwd, chalk.blue('running npm', cmd));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawn(npm, (cmd || 'install').split(' '), {cwd, env});
}

/**
 * runs docker command
 * @param cwd
 * @param cmd
 * @return {*}
 */
function docker(cwd, cmd) {
  console.log(cwd, chalk.blue('running docker', cmd));
  return spawn('docker', (cmd || 'build .').split(' '), {cwd, env});
}

function dockerSave(image, target) {
  console.log(chalk.blue(`running docker save ${image} | gzip > ${target}`));
  const spawn = require('child_process').spawn;
  const opts = {env};
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['save', image], opts);
    const p2 = spawn('gzip', [], opts);
    p.stdout.pipe(p2.stdin);
    p2.stdout.pipe(fs.createWriteStream(target));
    if (!quiet) {
      p.stderr.on('data', (data) => console.error(chalk.red(data.toString())));
      p2.stderr.on('data', (data) => console.error(chalk.red(data.toString())));
    }
    p2.on('close', (code) => code === 0 ? resolve() : reject(code));
  });
}

function dockerRemoveImages() {
  console.log(chalk.blue(`docker images | grep ${productName} | awk '{print $1":"$2}') | xargs --no-run-if-empty docker rmi`));
  const spawn = require('child_process').spawn;
  const opts = {env};
  return new Promise((resolve) => {
    const p = spawn('docker', ['images'], opts);
    const p2 = spawn('grep', [productName], opts);
    p.stdout.pipe(p2.stdin);
    const p3 = spawn('awk', ['{print $1":"$2}'], opts);
    p2.stdout.pipe(p3.stdin);
    const p4 = spawn('xargs', ['--no-run-if-empty', 'docker', 'rmi'], {env, stdio: [p3.stdout, 1, 2]});
    p4.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.log('invalid error code, but continuing');
        resolve();
      }
    });
  });
}

function createQuietTerminalAdapter() {
  const TerminalAdapter = require('yeoman-environment/lib/adapter');
  const impl = new TerminalAdapter();
  impl.log.write = function () {
    return this;
  };
  return impl;
}

/**
 * runs yo internally
 * @param generator
 * @param options
 * @param {string} cwd
 * @param {string[]|string} args
 */
function yo(generator, options, cwd, args) {
  const yeoman = require('yeoman-environment');
  // call yo internally
  const yeomanEnv = yeoman.createEnv([], {cwd, env}, quiet ? createQuietTerminalAdapter() : undefined);
  const _args = Array.isArray(args) ? args.join(' ') : args || '';
  return new Promise((resolve, reject) => {
    try {
      console.log(cwd, chalk.blue('running yo phovea:' + generator));
      yeomanEnv.lookup(() => {
        yeomanEnv.run(`phovea:${generator} ${_args}`, options, resolve);
      });
    } catch (e) {
      console.error('error', e, e.stack);
      reject(e);
    }
  });
}

function cloneRepo(p, cwd) {
  // either of them has to be defined
  p.name = p.name || fromRepoUrl(p.repo);
  p.repo = p.repo || `phovea/${p.name}`;
  p.branch = p.branch || 'master';

  return yo('clone-repo', {
    branch: p.branch,
    extras: '--depth 1',
    dir: p.name,
    cwd
  }, cwd, toRepoUrlWithUser(p.repo)); // pass repo url as argument
}

function resolvePluginType(p, dir) {
  if (!fs.existsSync(`${dir}/${p.name}/.yo-rc.json`)) {
    p.pluginType = 'lib';
    p.isHybridType = false;
    return;
  }
  return fs.readJSONAsync(`${dir}/${p.name}/.yo-rc.json`).then((json) => {
    p.pluginType = json['generator-phovea'].type;
    p.isHybridType = p.pluginType.includes('-');
  });
}

function loadComposeFile(dir, p) {
  const composeFile = `${dir}/${p.name}/deploy/docker-compose.partial.yml`;
  if (fs.existsSync(composeFile)) {
    const yaml = require('yamljs');
    return fs.readFileAsync(composeFile).then((content) => yaml.parse(content.toString()));
  }
  return Promise.resolve({});
}

function patchComposeFile(p, composeTemplate) {
  const service = {};
  if (composeTemplate && composeTemplate.services) {
    const firstService = Object.keys(composeTemplate.services)[0];
    // copy data from first service
    Object.assign(service, composeTemplate.services[firstService]);
    delete service.build;
  }
  service.image = p.image;
  if (p.type === 'web' || p.type === 'static') {
    service.ports = ['80:80'];
  }
  const r = {
    version: '2.0',
    services: {}
  };
  r.services[p.label] = service;
  return r;
}

function patchDockerfile(p, dockerFile) {
  if (!p.baseImage) {
    return null;
  }
  return fs.readFileAsync(dockerFile).then((content) => {
    content = content.toString();
    // patch the Dockerfile by replacing the FROM statement
    const r = /^\s*FROM (.+)\s*$/igm;
    const fromImage = r.exec(content)[1];
    console.log(`patching ${dockerFile} change from ${fromImage} -> ${p.baseImage}`);
    content = content.replace(r, `FROM ${p.baseImage}`);
    return fs.writeFileAsync(dockerFile, content);
  });
}

function patchWorkspace(p) {
  // prepend docker_script in the workspace
  if (fs.existsSync('./docker_script.sh')) {
    console.log('patch workspace and prepend docker_script.sh');
    let content = fs.readFileSync('./docker_script.sh').toString();
    if (fs.existsSync(p.tmpDir + '/docker_script.sh')) {
      content += '\n' + fs.readFileSync(p.tmpDir + '/docker_script.sh').toString();
    }
    fs.writeFileSync(p.tmpDir + '/docker_script.sh', content);
  }

  if (argv.injectVersion) {
    const pkgfile = `${p.tmpDir}/${p.name}/package.json`;
    if (fs.existsSync(pkgfile)) {
      const ppkg = require(pkgfile);
      ppkg.version = pkg.version;
      fs.writeJSONSync(pkgfile, ppkg);
    } else {
      console.warn('cannot inject version, main package.json not found');
    }
  }

  // inject extra phovea.js
  if (fs.existsSync('./phovea.js')) {
    console.log('patch workspace and add workspace phovea.js');
    let registry = fs.readFileSync(p.tmpDir + '/phovea_registry.js').toString();
    fs.copyFileSync('./phovea.js', p.tmpDir + '/phovea.js');

    registry += `\n\n
    import {register} from 'phovea_core/src/plugin';
    register('__product',require('./phovea.js'));
    `;
    fs.writeFileSync(p.tmpDir + '/phovea_registry.js', registry);
  }
}

function mergeCompose(composePartials) {
  let dockerCompose = {};
  composePartials.forEach((c) => mergeWith(dockerCompose, c));
  return dockerCompose;
}

function buildComposePartials(descs) {
  const validDescs = descs.filter((d) => !d.error);

  // merge a big compose file including all
  return Promise.all(validDescs.map((p) => {
    return Promise.all([loadComposeFile(p.tmpDir, p).then(patchComposeFile.bind(null, p))].concat(p.additional.map((pi) => loadComposeFile(p.tmpDir, pi))))
      .then((partials) => {
        p.composePartial = mergeCompose(partials);
      });
  }));
}

function buildCompose(descs, dockerComposePatch) {
  console.log('create docker-compose.yml');

  const dockerCompose = mergeCompose(descs.map((d) => d.composePartial).filter(Boolean));
  const services = dockerCompose.services;
  // link the api server types to the web types and server to the api
  const web = descs.filter((d) => d.type === 'web').map((d) => d.label);
  const api = descs.filter((d) => d.type === 'api').map((d) => d.label);
  api.forEach((s) => {
    web.forEach((w) => {
      services[w].links = services[w].links || [];
      services[w].links.push(`${s}:api`);
    });
  });
  descs.filter((d) => d.type === 'service').forEach((s) => {
    api.forEach((w) => {
      services[w].links = services[w].links || [];
      services[w].links.push(`${s.label}:${s.name}`);
    });
  });

  if (services._host) {
    // inline _host to apis
    const host = services._host;
    delete services._host;
    api.forEach((s) => {
      services[s] = mergeCompose([host, services[s]]);
    });
  }

  Object.keys(dockerComposePatch.services).forEach((service) => {
    if (services[service] !== undefined) {
      console.log(`patch generated docker-compose file for ${service}`);
      mergeWith(services[service], dockerComposePatch.services[service]);
    }
  });

  const yaml = require('yamljs');
  return fs.writeFileAsync('build/docker-compose.yml', yaml.stringify(dockerCompose, 100, 2))
    .then(() => dockerCompose);
}

function pushImages(images) {
  const dockerRepository = argv.pushTo;
  if (!dockerRepository) {
    return null;
  }
  console.log('push docker images');

  const tags = [];
  if (!argv.noDefaultTags) {
    tags.push(...images.map((image) => ({image, tag: `${dockerRepository}/${image}`})));
  }
  if (argv.pushExtra) { // push additional custom prefix without the version
    tags.push(...images.map((image) => ({
      image,
      tag: `${dockerRepository}/${image.substring(0, image.lastIndexOf(':'))}:${argv.pushExtra}`
    })));
  }
  if (tags.length === 0) {
    return Promise.resolve([]);
  }
  return Promise.all(tags.map((tag) => docker('.', `tag ${tag.image} ${tag.tag}`)))
    .then(() => Promise.all(tags.map((tag) => docker('.', `push ${tag.tag}`))));
}

function loadPatchFile() {
  const existsYaml = fs.existsSync('./docker-compose-patch.yaml');
  if (!existsYaml && !fs.existsSync('./docker-compose-patch.yml')) {
    return {services: {}};
  }
  const content = fs.readFileSync(existsYaml ? './docker-compose-patch.yaml' : './docker-compose-patch.yml');
  const yaml = require('yamljs');
  const r = yaml.parse(content.toString());
  if (!r.services) {
    r.services = {};
  }
  return r;
}

function fillDefaults(descs, dockerComposePatch) {
  const singleService = descs.length === 1 && (argv.forceLabel === undefined);

  descs.forEach((d, i) => {
    // default values
    d.additional = d.additional || [];
    d.data = d.data || [];
    d.name = d.name || (d.repo ? fromRepoUrl(d.repo) : d.label);
    d.label = d.label || d.name;
    d.symlink = d.symlink || null; // default value
    d.image = d.image || `${productName}${singleService ? '' : `/${d.label}`}:${pkg.version}`;
    // incorporate patch file
    if (dockerComposePatch.services[d.label] && dockerComposePatch.services[d.label].image) {
      // use a different base image to build the item
      d.baseImage = dockerComposePatch.services[d.label].image;
      delete dockerComposePatch.services[d.label].image;
    }
    // include hint in the tmp directory which one is it
    d.tmpDir = `./tmp${i}_${d.name.replace(/\s+/, '').slice(0, 5)}`;
  });

  return descs;
}

function asChain(steps, chain) {
  if (chain.length === 0) {
    return [];
  }
  const possibleSteps = Object.keys(steps);

  const callable = (c) => {
    if (typeof c === 'function') {
      return c;
    }

    if (typeof c === 'string') {
      // simple lookup
      if (!possibleSteps.includes(c)) {
        console.error('invalid step:', c);
        throw new Error('invalid step: ' + c);
      }
      return callable(steps[c]);
    }

    if (Array.isArray(c)) { // sequential sub started
      const sub = c.map(callable);
      return () => {
        console.log('run sequential sub chain: ', JSON.stringify(c, null, ' '));
        let step = Promise.resolve();
        for (const s of sub) {
          step = step.then(s);
        }
        return step;
      };
    }
    // parallel = object
    const sub = Object.keys(c).map((ci) => callable(c[ci]));
    return () => {
      console.log('run parallel sub chain: ', JSON.stringify(c, null, ' '));
      return Promise.all(sub.map((d) => d())); // run sub lazy combined with all
    };
  };
  return chain.map(callable);
}

function runChain(chain, catchErrors) {
  let start = null;
  let step = new Promise((resolve) => {
    start = resolve;
  });

  for (const c of chain) {
    step = step.then(c);
  }

  step.catch(catchErrors);

  return () => {
    start(); // resolve first to start chain
    return step; // return last result
  };
}

function strObject(items) {
  const obj = {};
  for (const item of items) {
    obj[item] = item;
  }
  return obj;
}

function buildDockerImage(p) {
  const buildInSubDir = p.type === 'web' || p.type === 'static';
  let buildArgs = '';
  // pass through http_proxy, no_proxy, and https_proxy env variables
  for (const key of Object.keys(process.env)) {
    const lkey = key.toLowerCase();
    if (lkey === 'http_proxy' || lkey === 'https_proxy' || lkey === 'no_proxy') {
      // pass through
      buildArgs += ` --build-arg ${lkey}='${process.env[key]}'`;
    }
  }

  // patch the docker file with the with an optional given baseImage
  return Promise.resolve(patchDockerfile(p, `${p.tmpDir}${buildInSubDir ? '/' + p.name : ''}/deploy/Dockerfile`))
    // create the container image
    .then(() => docker(`${p.tmpDir}${buildInSubDir ? '/' + p.name : ''}`, `build -t ${p.image}${buildArgs} -f deploy/Dockerfile .`))
    // tag the container image
    .then(() => argv.pushExtra ? docker(`${p.tmpDir}`, `tag ${p.image} ${p.image.substring(0, p.image.lastIndexOf(':'))}:${argv.pushExtra}`) : null);
}

function createWorkspace(p) {
  return yo('workspace', {noAdditionals: true, defaultApp: 'phovea'}, p.tmpDir)
    .then(() => patchWorkspace(p));
}

function installWebDependencies(p) {
  return npm(p.additional.length > 0 ? p.tmpDir : (`${p.tmpDir}/${p.name}`), 'install');
}

function cleanUpWebDependencies(p) {
  return fs.emptyDirAsync(p.additional.length > 0 ? `${p.tmpDir}/node_modules` : (`${p.tmpDir}/${p.name}/node_modules`));
}

function resolvePluginTypes(p) {
  if (p.pluginType) {
    return Promise.resolve(); // already resolved
  }
  if (p.additional.length === 0) {
    return resolvePluginType(p, p.tmpDir);
  }
  return Promise.all([resolvePluginType(p, p.tmpDir)].concat(p.additional.map((pi) => resolvePluginType(pi, p.tmpDir))));
}

function testWebAdditionals(p) {
  return Promise.all(p.additional.map((pi) => npm(p.tmpDir, `run test${pi.isHybridType ? ':web' : ''}:${pi.name}`)));
}

function buildWeb(p) {
  const hasAdditional = p.additional.length > 0;

  let step;
  if (hasAdditional) {
    step = npm(p.tmpDir, `run dist${p.isHybridType ? ':web' : ''}:${p.name}`);
  } else {
    step = npm(`${p.tmpDir}/${p.name}`, `run dist${p.isHybridType ? ':web' : ''}`);
  }
  // move to target directory
  return step.then(() => fs.renameAsync(`${p.tmpDir}/${p.name}/dist/${p.name}.tar.gz`, `./build/${p.label}.tar.gz`));
}

function installPythonTestDependencies(p) {
  console.log(chalk.yellow('create test environment'));
  return spawn('pip', 'install --no-cache-dir -r requirements.txt', {cwd: p.tmpDir})
    .then(() => spawn('pip', 'install --no-cache-dir -r requirements_dev.txt', {cwd: p.tmpDir}));
}

function buildServer(p) {
  let act = npm(`${p.tmpDir}/${p.name}`, `run build${p.isHybridType ? ':python' : ''}`);
  for (const pi of p.additional) {
    act = act.then(() => npm(`${p.tmpDir}/${pi.name}`, `run build${pi.isHybridType ? ':python' : ''}`));
  }

  // copy all together
  act = act
    .then(() => fs.ensureDirAsync(`${p.tmpDir}/build/source`))
    .then(() => fs.copyAsync(`${p.tmpDir}/${p.name}/build/source`, `${p.tmpDir}/build/source/`))
    .then(() => Promise.all(p.additional.map((pi) => fs.copyAsync(`${p.tmpDir}/${pi.name}/build/source`, `${p.tmpDir}/build/source/`))));

  // copy main deploy thing and create a docker out of it
  act = act
    .then(() => fs.ensureDirAsync(`${p.tmpDir}/deploy`))
    .then(() => fs.copyAsync(`${p.tmpDir}/${p.name}/deploy`, `${p.tmpDir}/deploy/`));

  return act;
}

function downloadServerDataFiles(p) {
  if (!argv.serial) {
    return Promise.all(p.data.map((d) => downloadDataFile(d, `${p.tmpDir}/build/source/_data`, p.tmpDir)));
  }
  // serial
  let act = Promise.resolve();
  for (const d of p.data) {
    act = act.then(() => downloadDataFile(d, `${p.tmpDir}/build/source/_data`, p.tmpDir));
  }
  return act;
}

function cleanWorkspace(descs) {
  console.log(chalk.yellow('clean workspace'));
  return Promise.all([fs.emptyDirAsync('build')].concat(descs.map((d) => fs.emptyDirAsync(d.tmpDir))));
}

if (require.main === module) {
  if (argv.skipTests) {
    // if skipTest option is set, skip tests
    console.log(chalk.blue('skipping tests'));
    env.PHOVEA_SKIP_TESTS = true;
  }
  if (argv.quiet) {
    console.log(chalk.blue('will try to keep my mouth shut...'));
  }
  const dockerComposePatch = loadPatchFile();
  const descs = fillDefaults(require('./phovea_product.json'), dockerComposePatch);

  if (fs.existsSync('.yo-rc.json')) {
    fs.renameSync('.yo-rc.json', '.yo-rc_tmp.json');
  }
  fs.ensureDirSync('build');

  const cleanUp = () => {
    if (fs.existsSync('.yo-rc_tmp.json')) {
      fs.renameSync('.yo-rc_tmp.json', '.yo-rc.json');
    }
  };

  const catchProductBuild = (p, act) => {
    // no chaining to keep error
    act.catch((error) => {
      p.error = error;
      console.error('ERROR building ', p.name, error);
    });
    return act;
  };

  const steps = {
    clean: () => cleanWorkspace(descs),
    prune: dockerRemoveImages,
    compose: () => buildComposePartials(descs).then(() => buildCompose(descs, dockerComposePatch)),
    push: () => pushImages(descs.filter((d) => !d.error).map((d) => d.image)),
    summary: () => {
      console.log(chalk.bold('summary: '));
      const maxLength = Math.max(...descs.map((d) => d.name.length));
      descs.forEach((d) => console.log(` ${d.name}${'.'.repeat(3 + (maxLength - d.name.length))}` + (d.error ? chalk.red('ERROR') : chalk.green('SUCCESS'))));
      const anyErrors = descs.some((d) => d.error);
      cleanUp();
      if (anyErrors) {
        process.exit(1);
      }
    }
  };

  const webTypes = ['static', 'web'];
  const serverTypes = ['api', 'service'];

  const chainProducts = [];
  for (let i = 0; i < descs.length; ++i) {
    const p = descs[i];
    const suffix = p.name;
    const hasAdditional = p.additional.length > 0;
    const isWeb = webTypes.includes(p.type);
    const isServer = serverTypes.includes(p.type);

    if (!isWeb && !isServer) {
      console.error(chalk.red('unknown product type: ' + p.type));
      continue;
    }

    fs.ensureDirSync(p.tmpDir);

    // clone repo
    const subSteps = [];
    steps[`clone:${suffix}`] = () => catchProductBuild(p, cloneRepo(p, p.tmpDir));
    subSteps.push(`clone:${suffix}`);

    if (hasAdditional) {
      // clone extras
      const cloneKeys = [];
      for (const pi of p.additional) {
        const key = `clone:${suffix}:${pi.name}`;
        steps[key] = () => catchProductBuild(p, cloneRepo(pi, p.tmpDir));
        cloneKeys.push(key);
      }

      if (argv.serial) {
        subSteps.push(...cloneKeys);
      } else {
        subSteps.push(strObject(cloneKeys));
      }
    }

    const needsWorskpace = (isWeb && hasAdditional) || isServer;
    steps[`prepare:${suffix}`] = needsWorskpace ? () => catchProductBuild(p, createWorkspace(p)) : null;

    if (isWeb) {
      steps[`install:${suffix}`] = () => catchProductBuild(p, installWebDependencies(p));
    } else { // server
      steps[`install:${suffix}`] = argv.skipTests ? () => null : () => catchProductBuild(p, installPythonTestDependencies(p));
    }
    steps[`test:${suffix}`] = isWeb && hasAdditional ? () => catchProductBuild(p, resolvePluginTypes(p).then(() => testWebAdditionals(p))) : () => null;
    steps[`build:${suffix}`] = isWeb ? () => catchProductBuild(p, resolvePluginTypes(p).then(() => buildWeb(p))) : () => catchProductBuild(p, resolvePluginTypes(p).then(() => buildServer(p)));
    steps[`data:${suffix}`] = () => catchProductBuild(p, downloadServerDataFiles(p));
    steps[`postbuild:${suffix}`] = isWeb ? () => catchProductBuild(p, cleanUpWebDependencies(p)) : () => null;
    steps[`image:${suffix}`] = () => catchProductBuild(p, buildDockerImage(p));
    steps[`save:${suffix}`] = () => catchProductBuild(p, dockerSave(p.image, `build/${p.label}_image.tar.gz`));

    subSteps.push(`prepare:${suffix}`);
    subSteps.push(`install:${suffix}`);
    if (!argv.skipTests) {
      subSteps.push(`test:${suffix}`);
    }
    subSteps.push(`build:${suffix}`);
    if (isServer && p.data.length > 0) {
      subSteps.push(`data:${suffix}`);
    }
    if (isWeb) {
      subSteps.push(`postbuild:${suffix}`);
    }
    subSteps.push(`image:${suffix}`);
    if (!argv.skipSaveImage) {
      subSteps.push(`save:${suffix}`);
    }

    steps[`product:${suffix}`] = subSteps;
    subSteps.name = `product:${suffix}`;
    chainProducts.push(subSteps);
  }

  // create some meta steps
  {
    const stepNames = Object.keys(steps);
    for (const meta of ['clone', 'prepare', 'build', 'test', 'postbuild', 'image', 'product', 'install']) {
      const sub = stepNames.filter((d) => d.startsWith(`${meta}:`));
      if (sub.length <= 0) {
        continue;
      }
      steps[meta] = argv.serial ? sub : strObject(sub);
    }
  }

  const chain = ['clean'];

  if (!argv.skipCleanUp) {
    chain.push('prune');
  }

  if (argv.serial) {
    chain.push(...chainProducts); // serially
  } else {
    const par = {};
    chainProducts.forEach((c) => {
      par[c.name] = c;
    });
    chain.push(par); // as object = parallel
  }
  // result of the promise is an array of partial docker compose files

  chain.push('compose');
  if (argv.pushTo) {
    chain.push('push');
  }
  chain.push('summary');

  // XX. catch all error handling
  const catchErrors = (error) => {
    console.error('ERROR extra building ', error);
    // rename back
    cleanUp();
    process.exit(1);
  };

  if (argv.help) {
    showHelp(steps, chain);
    cleanUp();
    process.exit(0);
  }

  if (argv._.length > 0) {
    // explicit chain replace computed one
    chain.splice(0, chain.length, ...argv._);
  }

  console.log(chalk.blue('executing chain:'), JSON.stringify(chain, null, ' '));
  const toExecute = asChain(steps, chain);
  const launch = runChain(toExecute, catchErrors);
  if (!argv.dryRun) {
    launch();
  }
}
