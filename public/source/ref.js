
var ko = require('../vendor/js/knockout-2.2.1.js');
var dialogs = require('./dialogs');
var md5 = require('blueimp-md5').md5;

var RefViewModel = function(args) {
	var self = this;
	this.node = ko.observable();
	this.boxDisplayX = ko.computed(function() {
		if (!self.node()) return 0;
		return self.node().x();
	});
	this.boxDisplayY = ko.computed(function() {
		if (!self.node()) return 0;
		return self.node().y();
	});
	this.name = args.name;
	this.localRefName = this.name; // origin/master or master
	this.refName = this.name; // master
	this.isRemoteTag = this.name.indexOf('remote-tag: ') == 0;
	this.isLocalTag = this.name.indexOf('tag: ') == 0;
	this.isTag = this.isLocalTag || this.isRemoteTag;
	var isRemoteBranchOrHEAD = this.name.indexOf('refs/remotes/') == 0;
	this.isLocalHEAD = this.name == 'HEAD';
	this.isRemoteHEAD = this.name.indexOf('/HEAD') != -1;
	this.isLocalBranch = this.name.indexOf('refs/heads/') == 0;
	this.isRemoteBranch = isRemoteBranchOrHEAD && !this.isRemoteHEAD;
	this.isStash = this.name.indexOf('refs/stash') == 0;
	this.isHEAD = this.isLocalHEAD || this.isRemoteHEAD;
	this.isBranch = this.isLocalBranch || this.isRemoteBranch;
	this.isRemote = isRemoteBranchOrHEAD || this.isRemoteTag;
	this.isLocal = this.isLocalBranch || this.isLocalTag;
	if (this.isLocalBranch) {
		this.localRefName = this.name.slice('refs/heads/'.length);
		this.refName = this.localRefName;
	}
	if (this.isRemoteBranch) {
		this.localRefName = this.name.slice('refs/remotes/'.length);
		this.refName = this.localRefName.split('/')[1];
	}
	if (this.isLocalTag) {
		this.localRefName = this.name.slice('tag: refs/tags/'.length);
		this.refName = this.localRefName;
	}
	if (this.isRemoteTag) {
		this.localRefName = this.name.slice('remote-tag: '.length);
		this.refName = this.localRefName.split('/')[1];
	}
	this.show = true;
	this.graph = args.graph;
	this.app = this.graph.app;
	this.localRef = ko.observable();
	this.isDragging = ko.observable(false);
	this.hasFocus = ko.observable(false);
	this.hasFocus.subscribe(function(newValue) {
		if (newValue)
			self.graph.currentActionContext(self);
		else {
			if (self.isDragging()) return;
			// CLicking otherwise immediately destroys focus, meaning the button is never hit
			setTimeout(function() {
				if (self.graph.currentActionContext() == self)
					self.graph.currentActionContext(null);
			}, 300);
		}
	});
	this.current = ko.computed(function() {
		return self.isLocalBranch && self.graph.checkedOutBranch() == self.refName;
	});
	this.color = args.color || this._colorFromHashOfString(this.refName);
}
RefViewModel.prototype._colorFromHashOfString = function(string) {
	return '#' + md5(string).toString().slice(0, 6);
}
exports.RefViewModel = RefViewModel;
RefViewModel.prototype.dragStart = function() {
	this.graph.currentActionContext(this);
	this.isDragging(true);
	if (document.activeElement) document.activeElement.blur();
}
RefViewModel.prototype.dragEnd = function() {
	this.graph.currentActionContext(null);
	this.isDragging(false);
}
RefViewModel.prototype.canBePushed = function(remote) {
	if (!this.isLocal) return false;
	var remoteRef = this.getRemoteRef(remote);
	if (!remoteRef) return true;
	return this.node() != remoteRef.node();
}
RefViewModel.prototype.getRemoteRef = function(remote) {
	return this.graph.getRef(this.getRemoteRefFullName(remote), false);
}
RefViewModel.prototype.getRemoteRefFullName = function(remote) {
	if (this.isLocalBranch) return 'refs/remotes/' + remote + '/' + this.refName;
	if (this.isLocalTag) return 'remote-tag: ' + remote + '/' + this.refName;
	throw new Error('Trying to construct remote-name of unsupported ref');
}
RefViewModel.prototype.moveTo = function(target, callback) {
	var self = this;
	if (this.isLocal) {
		if (this.current())
			this.app.post('/reset', { path: this.graph.repoPath, to: target }, callback);
		else if (this.isTag)
			this.app.post('/tags', { path: this.graph.repoPath, name: this.refName, startPoint: target, force: true }, callback);
		else
			this.app.post('/branches', { path: this.graph.repoPath, name: this.refName, startPoint: target, force: true }, callback);
	} else {
		var pushReq = { path: this.graph.repoPath, remote: this.graph.repository.remotes.currentRemote(),
			refSpec: target, remoteBranch: this.refName };
		this.app.post('/push', pushReq, function(err, res) {
				if (err) {
					if (err.errorCode == 'non-fast-forward') {
						var forcePushDialog = new dialogs.YesNoDialogViewModel('Force push?', 'The remote branch can\'t be fast-forwarded.');
						forcePushDialog.closed.add(function() {
							if (!forcePushDialog.result()) return callback();
							pushReq.force = true;
							self.app.post('/push', pushReq, callback);
						});
						self.app.showDialog(forcePushDialog);
						return true;
					} else {
						callback(err, res);
					}
				} else {
					callback();
				}
			});
	}
}
RefViewModel.prototype.createRemoteRef = function(callback) {
	this.app.post('/push', { path: this.graph.repoPath, remote: this.graph.repository.remotes.currentRemote(),
			refSpec: this.refName, remoteBranch: this.refName }, callback);
}