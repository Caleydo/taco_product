/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

module.exports = [
  {
    type: 'web',
    name: 'taco',
    repo: 'Caleydo/taco',
    branch: 'deploy',
    additional: []
  },
  {
    type: 'api__',
    name: 'taco_server',
    repo: 'Caleydo/taco_server',
    branch: 'deploy',
    additional: [{
      repo: 'phovea/phovea_data_hdf',
      branch: 'docker_env'
    }]
  }
];
