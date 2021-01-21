const Promise = require('bluebird');
const path = require('path');
const fs = Promise.promisifyAll(require('fs-extra'));
const chalk = require('chalk');
const yeoman = require('yeoman-environment');
const spawn = require('child_process').spawn;
const _ = require('lodash');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// see show help
const argv = require('yargs-parser')(process.argv.slice(2));
const env = Object.assign({}, process.env);

const PARAMS = {
  quiet: argv.quiet !== undefined || env.QUIET !== undefined,
  useSSH: argv.useSSH !== undefined || env.USE_SSH !== undefined,
  injectVersion: argv.injectVersion !== undefined || env.INEJECT_VERSION !== undefined,
  services: argv.services ? argv.services.split(',') : env.services ? env.services.split(',') : [],
  skipTests: argv.skipTests !== undefined || env.skipTests !== undefined,
  skipDocker: argv.skipDocker !== undefined || env.skipDocker !== undefined,
  version: argv.version || env.version,
  dockerRegistry: argv.dockerRegistry || env.dockerRegistry,
  dockerTags: argv.dockerTags ? argv.dockerTags.split(',') : env.dockerTags ? env.dockerTags.split(',') : [],
  dockerBuildArgs: argv.dockerBuildArgs || env.dockerBuildArgs
}


const LOGGING_MODE = {
  INFO: 1,
  WARNING: 2,
  ERROR: 3
};

const WEB_TYPES = ['static', 'web'];
const SERVER_TYPES = ['api', 'service'];
const PRODUCT_PART_COLORS = ['green', 'orange', 'magenta', 'cyan']; //don't use blue, yellow, red
const PRODUCT_PART_TYPES = WEB_TYPES.concat(SERVER_TYPES);

function showHelp() {
  console.info(`node build.js <options>
possible options (all can be also be transfered as environment variables):
 * --services      ... services or product parts, that should be build; otherwise all product parts will be build; seperated with ','
 * --skipTests     ... skip tests: will set the environment variable PHOVEA_SKIP_TESTS
 * --skipDocker    ... skip creating docker images and push them to registries
 * --injectVersion ... injects the product version into the package.json of the built component
 * --version       ... version to use for this product 
 * --useSSH        ... clone via ssh instead of https
 * --dockerRegister ... regisry to push the docker image
 * --dockerTags    ... docker tags for the registry; seperated with ','
 * --dockerBuildArgs ... build arguments for the docker image
 * --quiet         ... reduce log messages
 * --help          ... show this help message
arguments: (starting with --!)
 `);
}

/************************************************************************/
/** HELP FUNCTIONS */
/************************************************************************/
/**
 * run cmd with given args and opts as child process for the given product part
 * 
 * @param part product part
 * @param cmd command as array
 * @param args arguments
 * @param opts options
 * @returns a promise with the result code or a reject with the error string
 */
function runProcess(part, cmd, args, opts) {
  logging(LOGGING_MODE.INFO, part, `runProcess command:${cmd} with ${args}`);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, typeof args === 'string' ? args.split(' ') : args, _.merge({stdio: PARAMS.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 1, 2]}, opts));
    const out = [];
    if (p.stdout) {
      p.stdout.on('data', (chunk) => out.push(chunk));
    }
    if (p.stderr) {
      p.stderr.on('data', (chunk) => out.push(chunk));
    }
    p.on('close', (code, signal) => {
      if (code === 0) {
        logging(LOGGING_MODE.INFO, part, `runProcess ok status:${code}-${signal}`);
        resolve(code);
      } else {
        logging(LOGGING_MODE.ERROR, part, `runProcess status code:${code}-${signal}`);
        if (PARAMS.quiet) {
          // log output what has been captured
          logging(LOGGING_MODE.ERROR, part, out.join('\n'));
        }
        reject(new Error(`${cmd} failed with status code ${code} ${signal}`));
      }
    });
  });
}

/**
 * runs npm as new process with the given args for the given product part
 * 
 * @param part product part
 * @param cwd working directory
 * @param cmd the command to execute as a string
 * @return {*}
 */
function runNpm(part, cwd, cmd) {
  logging(LOGGING_MODE.INFO, part, `runNpm command:${cmd} in ${cwd}`);
  return runProcess(part, npm, (cmd || 'install').split(' '), {cwd, env});
}

/**
 * runs docker command for the given product part
 *
 * @param part product part
 * @param cwd directory to run
 * @param cmd docker command
 * @return {*}
 */
function runDocker(part, cwd, cmd) {
  logging(LOGGING_MODE.INFO, part, `runDocker: ${cmd} in  ${cwd}`);
  return runProcess(part, 'docker', (cmd || 'build .').split(' '), {cwd, env});
}

/**
 * generates a repo url to clone depending on the useSSH option
 * 
 * @param {string} url the repo url either in git@ for https:// form
 * @returns the clean repo url
 */
function toRepoUrl(url) {
  if (url.startsWith('git@')) {
    if (PARAMS.useSSH) {
      return url;
    }
    // have an ssh url need an http url
    const m = url.match(/(https?:\/\/([^/]+)\/|git@(.+):)([\w\d-_/]+)(.git)?/);
    return `https://${m[3]}/${m[4]}.git`;
  }
  if (url.startsWith('http')) {
    if (!PARAMS.useSSH) {
      return url;
    }
    // have a http url need an ssh url
    const m = url.match(/(https?:\/\/([^/]+)\/|git@(.+):)([\w\d-_/]+)(.git)?/);
    return `git@${m[2]}:${m[4]}.git`;
  }
  if (!url.includes('/')) {
    url = `Caleydo/${url}`;
  }
  if (PARAMS.useSSH) {
    return `git@github.com:${url}.git`;
  }
  return `https://github.com/${url}.git`;
}

/**
 * guesses the credentials environment variable based on the given repository hostname f.e. GITHUB_COM_CREDENTIALS otherwise PHOVEA_GITHUB_CREDENTIALS
 * 
 * @param {string} repo
 * @returns credentials for the given host
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

/**
 * adds credentials to the repo url
 * 
 * @param {string} repo url
 * @returns the repo url with the given credentials
 */
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

/**
 * get repo name from repo url
 * 
 * @param {string} url the repo url either in git@ for https:// form
 * @returns the clean repo name
 */
function getRepoNameFromUrl(url) {
  if (url.includes('.git')) {
    return url.match(/\/([^/]+)\.git/)[0];
  }
  return url.slice(url.lastIndexOf('/') + 1);
}


/**
 * logging method for this build.s 
 *
 * @param {LOGGING_MODE} loggingMode info, warning or error
 * @param part product part
 * @param message message that should be printed
 */
function logging(loggingMode, part, message){
  if(part && part.key) {
    message = part.key + ' - ' + message;
  }
  if(loggingMode === LOGGING_MODE.ERROR) {
    console.log(chalk.red(message));
    return;
  }
  if(PARAMS.quiet) {
    return;
  }
  if(part && part.color) {
    console.log(chalk.keyword(part.color)(message));
    return;
  }
  if(loggingMode === LOGGING_MODE.WARNING) {
    console.log(chalk.yellow(message));
    return;
  } 
  if(loggingMode === LOGGING_MODE.INFO) {
    console.log(chalk.blue(message));
    return;
  }
  console.log(chalk.white(message));
}

/**
 * returns a quiet terminal for yo command
 *
 * @return {*} quiet termin for yo command
 */
function createQuietTerminalAdapter() {
  const TerminalAdapter = require('yeoman-environment/lib/adapter');
  const impl = new TerminalAdapter();
  impl.log.write = function () {
    return this;
  };
  return impl;
}

/**
 * runs yo internally for the given product part
 *
 * @param part product part
 * @param generator
 * @param options
 * @param {string} cwd
 * @param {string[]|string} args
 */
function yo(part, generator, options, cwd, args) {
  // call yo internally
  const yeomanEnv = yeoman.createEnv([], {cwd, env}, PARAMS.quiet ? createQuietTerminalAdapter() : undefined);
  const _args = Array.isArray(args) ? args.join(' ') : args || '';
  return new Promise((resolve, reject) => {
    try {
      logging(LOGGING_MODE.INFO, part, `running yo phovea:${generator} ${args} ${JSON.stringify(options)}`);
      yeomanEnv.lookup(() => {
        yeomanEnv.run(`phovea:${generator} ${_args}`, options, resolve);
      });
    } catch (e) {
      logging(LOGGING_MODE.ERROR, part,`error: ${e} - ${e.stack}`);
      reject(e);
    }  
  });
}

/**
 * clone all repos of given product part
 * 
 * @param part product part
 */
function cloneRepos(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: cloneRepos');
  const allRepos = [ yo(part, 'clone-repo', {
    branch: part.branch,
    extras: '--depth 1',
    dir: part.repoName,
    cwd: part.tmpDir
  }, part.tmpDir, part.repoUrl)]; // pass repo url as argument
  return allRepos.concat(Object.keys(part.additionals).map((a)=>{
    return yo(part, 'clone-repo', {
      branch: part.additionals[a].branch,
      extras: '--depth 1',
      dir: part.additionals[a].repoName,
      cwd: part.tmpDir
    }, part.tmpDir, part.additionals[a].repoUrl)
  }));
}

/**
 * print all files of a given directory
 * 
 * @param part product part
 * @param dir directory
 */
function showFilesInFolder(part, dir) {
  logging(LOGGING_MODE.INFO, part, `showFilesInFolder: ${dir}`);
  fs.readdirSync(dir).map((file) => logging(LOGGING_MODE.INFO, part, file));
}


/**
 * download data from given url
 * 
 * @param part product part
 * @param {string} url the data url
 * @returns the clean data name
 */
function downloadDataUrl(part, url, dest) {
  if (!url.startsWith('http')) {
    url = `https://s3.eu-central-1.amazonaws.com/phovea-data-packages/${url}`;
  }
  const http = require(url.startsWith('https') ? 'https' : 'http');
  logging(LOGGING_MODE.INFO, part, `STEP: downloadDataUrl with ${url}`);
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

/**
 * get download name from data url
 * 
 * @param {string} url the data url either in git@ for https:// form
 * @returns the clean data name
 */
function getDownloadName(url) {
  if (!url.startsWith('http')) {
    return url;
  }
  return url.substring(url.lastIndexOf('/') + 1);
}


/************************************************************************/
/** WORKSPACE FUNCTIONS */
/************************************************************************/

/**
 * change workspace by using the templates files of the product and by injecting the version of the package.json
 * 
 * @param part product part
 */
function patchWorkspace(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: patchWorkspace');
  function injectVersion(targetPkgFile, targetVersion) {
    if (fs.existsSync(targetPkgFile)) {
      const ppkg = require(targetPkgFile);
      ppkg.version = targetVersion;
      logging(LOGGING_MODE.INFO, part, `patchWorkspace: Write version ${targetVersion} into ${targetPkgFile}`);
      fs.writeJSONSync(targetPkgFile, ppkg, {spaces: 2});
    } else {
      logging(LOGGING_MODE.WARNING, part, `Cannot inject version: ${targetPkgFile} not found`);
    }
  }
  const targetPkgFile = `${part.tmpDir}/package.json`;
  if (PARAMS.injectVersion) {
    // inject version of product package.json into workspace package.json
    injectVersion(targetPkgFile, part.version);
  } else {
    // read default app package.json
    const defaultAppPkgFile = `${part.tmpDir}/${part.repoName}/package.json`;
    if (fs.existsSync(defaultAppPkgFile)) {
      logging(LOGGING_MODE.INFO, part, `inject version by reading the package json of ${part.repoName}`);
      const sourcePkg = require(defaultAppPkgFile);
      // inject version of default app package.json into workspace package.json
      injectVersion(targetPkgFile, sourcePkg.version);
    } else {
      logging(LOGGING_MODE.WARNING, part, `Cannot read version from default app package.json: ${defaultAppPkgFile} not found`);
    }
  }

  //copy template files of product to workspace of product
  if (fs.existsSync(`./templates/${part.key}`)) {
    logging(LOGGING_MODE.INFO, part, `Copy template files from ./templates/${part.key} to ${part.tmpDir}/`);
    fs.copySync(`./templates/${part.key}`, `${part.tmpDir}/`);
  } 
}

/**
 * creates workspace for the given product part
 * 
 * @param part product part
 */
function createWorkspace(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: createWorkspace');
  return yo(part, 'workspace', {noAdditionals: true, defaultApp: part.repoName, addWorkspaceRepos: false}, part.tmpDir)
    .then(() => patchWorkspace(part))
    .then(() => showFilesInFolder(part, part.tmpDir));
}

/**
 * resolve pluginType of the given product part by reading the yo-rc file
 * 
 * @param part product part
 */
function resolvePluginType(parentPart, part, dir) {
  const json = fs.readJSONSync(`${dir}/${part.repoName}/.yo-rc.json`);
  part.pluginType = json['generator-phovea'].type;
  part.isHybridType = part.pluginType.includes('-');
  logging(LOGGING_MODE.INFO, parentPart, `pluginType for ${parentPart.key}/${part.repoName}/): ${part.pluginType} - hybridType ${part.isHybridType}`);
}

/**
 * resolve pluginType for the given product part and all it's additionals
 * 
 * @param part product part
 */
function resolvePluginTypes(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: resolvePluginTypes');
  if (part.pluginType) {
    return Promise.resolve(); // already resolved
  }
  if (Object.keys(part.additionals).length === 0) {
    return resolvePluginType(part, part, part.tmpDir);
  }
  return Promise.all([resolvePluginType(part, part, part.tmpDir)].concat(Object.keys(part.additionals).map((pik) => resolvePluginType(part, part.additionals[pik], part.tmpDir))));
}

/************************************************************************/
/** WEB FUNCTIONS */
/************************************************************************/

/**
 * install web dependencies for given product part
 * 
 * @param part product part
 */
function installWebDependencies(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: installWebDependencies');
  return runNpm(part, part.tmpDir, 'install').then(() => showWebDependencies(part));
}

/**
 * show npm dependencies for given product part
 * 
 * @param part product part
 */
function showWebDependencies(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: showWebDependencies');
  // `npm ls` fails if some peerDependencies are not installed
  // since this function is for debug purposes only, we catch possible errors of `npm()` and resolve it with status code `0`.
  return runNpm(part, part.tmpDir, 'list --depth=1')
    .catch(() => Promise.resolve(0)); // status code = 0
}

/**
 * removes content of node_modules folder for given product part
 * 
 * @param part product part
 */
function cleanUpWebDependencies(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: cleanUpWebDependencies');
  return fs.emptyDirAsync(`${part.tmpDir}/node_modules` );
}

/**
 * build web source of given product part
 * 
 * @param part product part
 */
function buildWeb(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: buildWeb');
  //run dist of web
  const step = runNpm(part, part.tmpDir, `run dist`);
  // move to target directory and clean web dependencies
  return step.then(() => fs.copyAsync(`${part.tmpDir}/dist/bundles.tar.gz`, `./build/${part.key}.tar.gz`)).then(() => cleanUpWebDependencies(part));
}

/************************************************************************/
/** PYTHON FUNCTIONS */
/************************************************************************/

/**
 * install python requirements of the given product part
 * 
 * @param part product part
 */
function installPythonRequirements(part) {
  logging(LOGGING_MODE.INFO, part, `installPythonRequirements`);
  return runProcess(part, 'pip', 'install --no-cache-dir -r requirements.txt', {cwd: part.tmpDir})
    .then(() => runProcess(part, 'pip', 'install --no-cache-dir -r requirements_dev.txt', {cwd: part.tmpDir})).then(() => showPythonRequirements(part));
}

/**
 * show python requirements of the given product part
 * 
 * @param part product part
 */
function showPythonRequirements(part) {
  logging(LOGGING_MODE.INFO, part, `showPythonRequirements`);
  // since this function is for debug purposes only, we catch possible errors and resolve it with status code `0`.
  return runProcess(part, 'pip', 'list', {cwd: part.tmpDir})
    .catch(() => Promise.resolve(0)); // status code = 0
}

/**
 * build python source of given product part and additionals
 * 
 * @param part product part
 */
function buildPython(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: buildPython');
  //run build:python or run build
  let act = runNpm(part, `${part.tmpDir}/${part.repoName}`, `run build${part.isHybridType ? ':python' : ''}`);
  for (const pik of Object.keys(part.additionals)) {
    act = act.then(() => runNpm(part, `${part.tmpDir}/${part.additionals[pik].repoName}`, `run build${part.additionals[pik].isHybridType ? ':python' : ''}`));
  }

  // copy all together to build folder
  act = act
    .then(() => fs.ensureDirAsync(`${part.tmpDir}/build/source`))
    .then(() => fs.copyAsync(`${part.tmpDir}/${part.repoName}/build/source`, `${part.tmpDir}/build/source/`))
    .then(() => Promise.all(Object.keys(part.additionals).map((pik) => fs.copyAsync(`${part.tmpDir}/${part.additionals[pik].repoName}/build/source`, `${part.tmpDir}/build/source/`))));

  return act;
}

/************************************************************************/
/** DOCKER FUNCTIONS */
/************************************************************************/

/**
 * download data files for the given data description and product part
 * 
 * @param part product part
 * @param dataDesc data description
 * @param cwdestDird destination directory
 * @param cwd directory
 */
function downloadDataFile(part, dataDesc, destDir, cwd) {
  if (typeof dataDesc === 'string') {
    dataDesc = {
      type: 'url',
      url: desc
    };
  }
  dataDesc.type = dataDesc.type || (dataDesc.url ? 'url' : (dataDesc.repo ? 'repo' : 'unknown'));
  switch (dataDesc.type) {
    case 'url': {
      dataDesc.name = dataDesc.name || getDownloadName(desc.url);
      logging(LOGGING_MODE.INFO, part, `STEP: downloadDataFile with ${dataDesc}`);
      return fs.ensureDirAsync(destDir).then(() => downloadDataUrl(part, dataDesc.url, `${destDir}/${dataDesc.name}`));
    }
    case 'repo': {
      dataDesc.name = dataDesc.name || getRepoNameFromUrl(dataDesc.repo);
      let downloaded;
      if (fs.existsSync(path.join(cwd, dataDesc.name))) {
        downloaded = Promise.resolve(dataDesc);
      } else {
        downloaded = yo('clone-repo', {
          branch: dataDesc.branch || master,
          extras: '--depth 1',
          dir: dataDesc.name,
          cwd
        }, cwd, toRepoUrlWithUser(dataDesc.repo)); // pass repo url as argument
      }
      logging(LOGGING_MODE.INFO, part, `STEP: downloadDataFile with ${dataDesc}`);
      return downloaded.then(() => fs.copyAsync(`${cwd}/${dataDesc.name}/data`, `${destDir}/${dataDesc.name}`));
    }
    default:
      throw new Error('unknown data type:', dataDesc.type);
  }
}

/**
 * download all data, described in the data part of the given product part
 * 
 * @param part product part
 */
function downloadServerDataFiles(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: downloadServerDataFiles');
  return Promise.all(part.data.map((d) => downloadDataFile(part, d, `${part.tmpDir}/build/source/_data`, part.tmpDir)));
}

/**
 * build docker images for given product part
 * 
 * @param part product part
 */
function buildDockerImage(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: buildDockerImage');
  let buildArgs = '';
  // pass through http_proxy, no_proxy, and https_proxy env variables
  for (const key of Object.keys(process.env)) {
    const lkey = key.toLowerCase();
    if (lkey === 'http_proxy' || lkey === 'https_proxy' || lkey === 'no_proxy') {
      // pass through
      buildArgs += ` --build-arg ${lkey}='${process.env[key]}'`;
    }
  }
  if(PARAMS.buildArgs) {
    buildArgs += ` --build-arg ${PARAMS.buildArgs}`;
  }
  const dockerFile = `deploy/${part.type}/Dockerfile`;
  if(!fs.existsSync(`${part.tmpDir}/${dockerFile}`)){
    throw new Error(`No valid Dockerfile for ${part.type} found: ${part.tmpDir}/dockerFile`);
  }
  logging(LOGGING_MODE.INFO, part, `use dockerfile: ${dockerFile}`);
  //build docker image
  return Promise.resolve(runDocker(part, `${part.tmpDir}`, `build -t ${part.image}${buildArgs} -f ${dockerFile} .`))
    // tag the container image
    .then(() => part.dockerTags.length > 0 ? Promise.all(part.dockerTags.map((tag) => runDocker(part, `${part.tmpDir}`, `tag ${part.image} ${tag}`))) : null);
}

/**
 * push images for given product part
 * 
 * @param part product part
 */
function pushImage(part) {
  if(PARAMS.skipDocker) {
    return Promise.resolve();
  }
  logging(LOGGING_MODE.INFO, part, 'STEP: pushImage for tags: ' + part.dockerTags);
  return Promise.all(part.dockerTags.map((tag) => runDocker(part, '.', `push ${tag}`)));
}

/**
 * @deprecated save docker images to build folder
 * 
 * @param part product part
 */
function saveDockerImage(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: saveDockerImage');
  const target = `build/${part.key}_image.tar.gz`;
  logging(LOGGING_MODE.INFO, part, `running docker save ${part.image} | gzip > ${target}`);
  const opts = {env};
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['save', part.image], opts);
    const p2 = spawn('gzip', [], opts);
    p.stdout.pipe(p2.stdin);
    p2.stdout.pipe(fs.createWriteStream(target));
    if (!PARAMS.quiet) {
      p.stderr.on('data', (data) => console.error(chalk.red(data.toString())));
      p2.stderr.on('data', (data) => console.error(chalk.red(data.toString())));
    }
    p2.on('close', (code) => code === 0 ? resolve() : reject(code));
  });
}

/************************************************************************/
/** MAIN FUNCTIONS */
/************************************************************************/

/**
 * build source of given product part
 * 
 * @param part product part
 */
function build(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: build');
  if(part.isWebType) {
    return buildWeb(part).then(()=> showFilesInFolder(part, `${part.tmpDir}/bundles`));
  } else {
    return buildPython(part).then(()=> showFilesInFolder(part, `${part.tmpDir}/build/source`));
  }
}

/**
 * install dependencies / requirements of given product part
 * 
 * @param part product part
 */
function install(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: install');
  if(part.isWebType) {
    return installWebDependencies(part);
  } else {
    return installPythonRequirements(part);
  }
}

/**
 * prepare tmp directory of product part for building prodct part
 * 
 * @param part product part to create directory
 */
function prepare(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: prepare');
  //empty directory of product part
  fs.ensureDirSync(part.tmpDir);
  fs.emptyDirSync(part.tmpDir);
  //clone all repos of the product part
  //resolve plugin types in yo-rc file
  //create workspace
  return Promise.all(cloneRepos(part)).then(() => resolvePluginTypes(part)).then(() => createWorkspace(part));  
}

/**
 * prepare tmp directory of product part for building prodct part
 * @param part product part to create directory
 */
function createDocker(part) {
  if(PARAMS.skipDocker) {
    return Promise.resolve();
  }
  logging(LOGGING_MODE.INFO, part, 'STEP: createDocker');
  //empty directory of product part
  return downloadServerDataFiles(part).then(() => buildDockerImage(part));
}

/**
 * build the given prodct part
 * 
 * @param part product part to create directory
 */
function buildProductPart(part) {
  logging(LOGGING_MODE.INFO, part, 'STEP: createProductPart');
  //prepare product part
  return prepare(part)
  //install all dependencies/requirements
  .then(() => install(part)
  //build product part
  .then(() => build(part)
  //create docker images
  .then(() => createDocker(part))));
}

/**
 * returns for each part in the phovea_product json a description
 * 
 * @param pkg package json of the product
 * @return {*}
 * returns for each key in the phovea_product the following values
 *  - key
 *  - repoName
 *  - repoUrl
 *  - branch
 *  - data
 *  - image
 *  - tmpDir
 *  - isWebType
 *  - isServerType
 *  - additionals: array of objects, with the following attributes:
 *    - key
 *    - branch
 *    - repoUrl
 *    - repoName
 */
function getProductParts(pkg) {
  logging(LOGGING_MODE.INFO, null, 'STEP: getProductParts');
  const descs = require('./phovea_product.json');
  const productName = pkg.name.replace('_product', '');
  //throw an error if there is no description for the product
  if(!descs || !Object.keys(descs) || Object.keys(descs).length < 1) {
    throw new Error('No product part description in phovea_product.json file!');
  }
  //check the argument services
  if(PARAMS.services) {
    PARAMS.services.map((e) => {
      if(!Object.keys(descs).includes(e)) {
        throw new Error(`Product part '${e}' in phovea_product.json unknown. Possible values: '${JSON.stringify(Object.keys(descs))}'`);
      }
    });
  }
  //part of the product that should be build
  const partKeys = (PARAMS.services && PARAMS.services.length > 0) ? PARAMS.services : Object.keys(descs);
  const singleService = partKeys.length === 1;
  return partKeys.map((key, i) => {
    //check type of product part
    if(!descs[key].type || !PRODUCT_PART_TYPES.includes(descs[key].type.toLowerCase()))
    {
      throw new Error(`Product part '${key}' in phovea_product.json has no or wrong type: ${descs[key].type}. Possible values are: ${PRODUCT_PART_TYPES}`);
    }
    //check if repo of product part is given
    if(!descs[key].repo)
    {
      throw new Error(`Product part '${key}' in phovea_product.json has no repo property.`);
    }
    const part = descs[key];
    part.key = key;
    part.repoName =  part.repoName || getRepoNameFromUrl(part.repo);
    part.repoUrl = toRepoUrlWithUser(part.repo);
    part.branch = part.branch || 'master';
    part.data = descs[key].data || [];    
    part.additionals = part.additionals || {};
    part.image = part.image || `${productName}${singleService ? '' : `/${part.key}`}:${pkg.version}`;
    part.version = part.version || pkg.version;
    part.tmpDir = `./tmp_${part.key.replace(/\s+/, '')}`;
    part.isWebType = WEB_TYPES.includes(part.type);
    part.isServerType = SERVER_TYPES.includes(part.type);
    part.color = part.color || PRODUCT_PART_COLORS[i % PRODUCT_PART_COLORS.length];
    part.dockerTags = part.dockerTags || PARAMS.dockerTags;
    if(PARAMS.dockerRegistry) {
      part.dockerTags.push(`${PARAMS.dockerRegistry}/${part.image}`);
    }
    Object.keys(part.additionals).map((aKey) => {
      //check if repo of the addional is given
      if(!part.additionals[aKey].repo) {
        throw new Error(`Product part '${key}' in phovea_product.json has missing repo property for '${aKey}'`);
      }
      part.additionals[aKey].branch = part.additionals[aKey].branch || 'master';
      part.additionals[aKey].repoName =  part.additionals[aKey].repoName || getRepoNameFromUrl(part.additionals[aKey].repo);
      part.additionals[aKey].repoUrl = toRepoUrlWithUser(part.additionals[aKey].repo);
    });
    logging(LOGGING_MODE.INFO, part, `Product part '${key}' use the following defaults '${JSON.stringify(part)}'`);
    return part;
  });

}
/**
 * check and logs the arguments of the build command
 */
function checkArguments(pkg) {
  logging(LOGGING_MODE.INFO, null, 'STEP: checkArguments');
  logging(LOGGING_MODE.INFO, null, `Used parameters: ${JSON.stringify(PARAMS)}`);
  //set the env variable PHOVEA_SKIP_TESTS if argument skipTests is set
  if (PARAMS.skipTests) {
    logging(LOGGING_MODE.INFO, null, 'skipping tests');
    env.PHOVEA_SKIP_TESTS = true;
  }
  //log if argument quiet is set
  if (PARAMS.quiet) {
    logging(LOGGING_MODE.INFO, null, 'Will try to keep my mouth shut...');
  }
  //log given arguments
  logging(LOGGING_MODE.INFO, null, 'The following arguments are passed: ' + JSON.stringify(argv));
  logging(LOGGING_MODE.INFO, null, 'The following env are passed: ' + JSON.stringify(env));
  logging(LOGGING_MODE.INFO, null, 'The following package.json is passed: ' + JSON.stringify(pkg));
}


/**
 * returns buildId, generated by the date
 * @return {*}
 */
function getBuildId() {
  const now = new Date();
  const prefix = (n) => n < 10 ? ('0' + n) : n.toString();
  const buildId = `${now.getUTCFullYear()}${prefix(now.getUTCMonth()+1)}${prefix(now.getUTCDate())}-${prefix(now.getUTCHours())}${prefix(now.getUTCMinutes())}${prefix(now.getUTCSeconds())}`;
  logging(LOGGING_MODE.INFO, null, 'generated BuildId: ' + buildId);
  return buildId;
}

if (require.main === module) {
  try {
    if (argv.help) {
      showHelp();
      return;
    }
    const pkg = require('./package.json');
    const buildId = PARAMS.version ? PARAMS.version : getBuildId();
    pkg.version = pkg.version.replace('SNAPSHOT', buildId);
    //check arguments
    checkArguments(pkg);
    //get product parts, that should be build
    const productParts = getProductParts(pkg);
    //run all product part builds
    Promise.all(productParts.map((part) => buildProductPart(part)))
    //then push all images
    .then(() => Promise.all(productParts.map((part) => pushImage(part))));
  } catch(e) {
    logging(LOGGING_MODE.ERROR, null, e.message);
    logging(LOGGING_MODE.ERROR, null, e.stack);
  }
}
