'use strict';

const github = require('./github');
const gitlab = require('./gitlab');

module.exports = {
  github: {
    service: 'GitHub', item: 'pull request', short: 'PR', symbol: '#', example: 'owner/repo#123',
    setting: 'difftastic.ghPath',
    parse: github.pullRequest,
    load: github.loadPullRequest,
    loadComments: github.loadReviewComments,
    postComment: github.postReviewComment,
    deleteComment: github.deleteReviewComment,
    listForBranch: github.pullRequestsForBranch
  },
  gitlab: {
    service: 'GitLab', item: 'merge request', short: 'MR', symbol: '!', example: 'group/project!123',
    setting: 'difftastic.glabPath',
    parse: gitlab.mergeRequest,
    load: gitlab.loadMergeRequest,
    loadComments: gitlab.loadMergeRequestComments,
    postComment: gitlab.postMergeRequestComment,
    deleteComment: gitlab.deleteMergeRequestComment,
    listForBranch: gitlab.mergeRequestsForBranch
  }
};
