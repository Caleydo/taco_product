/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

module.exports = [
  {
    type: 'web__',
    name: 'taco',
    repo: 'Caleydo/taco',
    branch: 'deploy',
    additional: []
  },
  {
    type: 'server',
    label: 'taco_server',
    name: 'phovea_server',
    branch: 'docker_env',
    additional: [{
      name: 'phovea_data_hdf',
      branch: 'docker_env'
    }, {
      name: 'taco_server',
      repo: 'Caleydo/taco_server',
      branch: 'deploy'
    }]
  }
];
