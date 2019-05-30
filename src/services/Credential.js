//
// Created by Zeev Glozman
// Beame.io Ltd, 2016.
//
/*jshint esversion: 6 */
"use strict";

/** @namespace Credential **/


/**
 * @typedef {Object} MetadataObject
 * @property {String} fqdn
 * @property {String|null} [parent_fqdn]
 * @property {String|null} [approved_by_fqdn]
 * @property {String|null} [name]
 * @property {String|null} [email]
 * @property {Number} level
 * @property {Array|null} [actions]
 * @property {Array|null} [dnsRecords]
 * @property {Object|null} [ocspStatus]
 * @property {String} path => path to local creds folder
 */

/**
 * @typedef {Object} SignedData
 * @property {Number} created_at
 * @property {Number} valid_till
 * @property {Object|String|null} data
 */

/** @typedef {Object} RegistrationTokenOptionsToken
 *  @property {String} fqdn
 *  @property {String|null|undefined} [name]
 *  @property {String|null|undefined} [email]
 *  @property {String|null|undefined} [userId]
 *  @property {Number|null|undefined} [ttl]
 *  @property {String|null|undefined} [src]
 *  @property {String|null|undefined} [serviceName]
 *  @property {String|null|undefined} [serviceId]
 *  @property {String|null|undefined} [matchingFqdn]
 *  @property {String|null|undefined} [gwFqdn]
 *  @property {Boolean|null|undefined} [imageRequired]
 */

/**
 * @typedef {Object} RequestCertOptions
 * @property {Number|null} [validityPeriod]
 * @property {String|null} [password]
 * @property {Boolean|true} [saveCerts]
 */

/**
 * signature token structure , used as AuthorizationToken in Provision
 * @typedef {Object} SignatureToken
 * @property {String} signedData
 * @property {String} signedBy
 * @property {String} signature
 */
const pem                    = require('pem');
const NodeRsa                = require("node-rsa");
const async                  = require('async');
const _                      = require('underscore');
const Config                 = require('../../config/Config');
const actionsApi             = Config.ActionsApi;
const envProfile             = Config.SelectedProfile;
const module_name            = Config.AppModules.Credential;
const logger_entity          = "Credential";
const BeameLogger            = require('../utils/Logger');
const logger                 = new BeameLogger(module_name);
const BeameStoreDataServices = require('../services/BeameStoreDataServices');
const OpenSSLWrapper         = require('../utils/OpenSSLWrapper');
const openSSlWrapper         = new OpenSSLWrapper();
const beameUtils             = require('../utils/BeameUtils');
const CommonUtils            = require('../utils/CommonUtils');
const ProvisionApi           = require('../services/ProvisionApi');
const apiEntityActions       = actionsApi.EntityApi;
const apiAuthServerActions   = actionsApi.AuthServerApi;
const DirectoryServices      = require('./DirectoryServices');
const CryptoServices         = require('../services/Crypto');
const storeCacheServices     = (require('./StoreCacheServices')).getInstance();
const ocspUtils              = require('../utils/ocspUtils');
const timeFuzz               = Config.defaultTimeFuzz * 1000;
const util                   = require('util');
const dns                    = require('dns');
const debug_dns              = require('debug')(Config.debugPrefix + 'dns');

const nop = function () {
};

const CertValidationError = Config.CertValidationError;


class CertificateValidityError extends Error {
	get errorCode() {
		return this._errorCode;
	}

	constructor(message, code) {
		super(message);
		this._errorCode = code;
	}
}

/**
 * You should never initiate this class directly, but rather always access it through the beameStore.
 *
 *
 */
class Credential {

	/**
	 *
	 * @param {BeameStoreV2} store
	 */
	constructor(store) {
		if (store) {
			//noinspection JSUnresolvedVariable
			/** @member {BeameStoreV2}*/
			this.store = store;
		}

		//noinspection JSUnresolvedVariable
		/** @member {String} */
		this.fqdn = null;

		/** @member {MetadataObject} */
		this.metadata = {};

		/** @member {Array.<Credential>} */
		this.children = [];

		this.expired = false;

		// cert files
		/** @member {Buffer}*/
		this.PRIVATE_KEY = null;
		/** @member {Buffer}*/
		this.CA = null;
		/** @member {Buffer}*/
		this.X509 = null;
		/** @member {Buffer}*/
		this.PKCS7 = null;
		/** @member {Buffer}*/
		this.PKCS12 = null;
		/** @member {Buffer}*/
		this.P7B = null;
		/**
		 * @member {Buffer}
		 * Password for PKCS12(pfx) file
		 */
		this.PWD = null;

		/**
		 * @member {String}
		 * Public key as PEM string
		 */
		this.publicKeyStr = null;

		/** @member {NodeRSA}*/
		this.publicKeyNodeRsa = null;

		/** @member {NodeRSA}*/
		this.privateKeyNodeRsa = null;

		/**
		 * Object represents X509 properties: issuer {country, state, locality, organization, organizationUnit, commonName, emailAddress}, serial,country,state,locality,organization,organizationUnit, commonName,emailAddress,san and validity
		 * @member {Object}
		 */
		this.certData = {};
		
		/**
		 * This object is required due to async certificate load operation with latest node and pem modules
		*/
		this._initPromise = null;
	}

	//region Init functions
	/**
	 * @ignore
	 * @param fqdn
	 * @param metadata
	 */
	initWithFqdn(fqdn, metadata) {
		//noinspection JSUnresolvedVariable
		this.fqdn = fqdn;

		/** @member {BeameStoreDataServices} */
		this.beameStoreServices = new BeameStoreDataServices(this.fqdn, this.store, this.parseMetadata(metadata));
		this.parseMetadata(metadata);
		this.beameStoreServices.setFolder(this);
		this.initCryptoKeys();

	}

	/**
	 * @ignore
	 * @param fqdn
	 */
	initFromData(fqdn) {
		//noinspection JSUnresolvedVariable
		this.fqdn               = fqdn;
		this.beameStoreServices = new BeameStoreDataServices(this.fqdn, this.store);
		this.loadCredentialsObject();
		this.initCryptoKeys();

	}

	_updateCertData() {
		//get x509 cert data
		try {
			const x509Path = beameUtils.makePath(this.getMetadataKey("path"), Config.CertFileNames.X509);

			const rs   = require('jsrsasign');
			const X509 = rs.X509;
			const fs   = require('fs');
			let pemStr = (fs.readFileSync(x509Path)).toString();
			let x      = new rs.X509();
			x.readCertPEM(pemStr);


			let hex          = X509.pemToHex(pemStr);
			let fingerprints = {
				    'sha1':   rs.KJUR.crypto.Util.hashHex(hex, 'sha1'),
				    'sha256': rs.KJUR.crypto.Util.hashHex(hex, 'sha256')
			    },
			    ai           = X509.getExtAIAInfo(hex),
			    alt          = X509.getExtSubjectAltName(hex),
			    keyUsageStr  = X509.getExtKeyUsageString(hex),
			    alg          = x.getSignatureAlgorithmField(),
			    subjectStr   = x.getSubjectString();

			let subject = {
				"commonName":   "",
				"country":      "",
				"locality":     "",
				"state":        "",
				"organization": ""
			};

			let sp = subjectStr.split('/');
			for (let i = 0; i < sp.length; i++) {
				let pair = sp[i].split('=');
				if (pair.length != 2) continue;

				let prefix = pair[0];

				switch (prefix) {
					case 'CN':
						subject.commonName = pair[1];
						break;
					case 'C':
						subject.country = pair[1];
						break;
					case 'L':
						subject.locality = pair[1];
						break;
					case 'ST':
						subject.state = pair[1];
						break;
					case 'O':
						subject.organization = pair[1];
						break;
				}
			}


			this.certData.extensions           = {
				keyUsage:               keyUsageStr,
				authorityKeyIdentifier: X509.getExtAuthorityKeyIdentifier(hex).kid.match(/(..)/g).join(':').toUpperCase(),
				subjectKeyIdentifier:   X509.getExtSubjectKeyIdentifier(hex).match(/(..)/g).join(':').toUpperCase()
			};
			this.certData.fingerprints         = fingerprints;
			this.certData.subject              = subject;
			this.certData.altNames             = alt;
			this.certData.publicKey            = 'RSA Encryption ( 1.2.840.113549.1.1.1 )';
			this.certData.signatureAlgorithm   = alg === "SHA256withRSA" ? 'SHA-256 with RSA Encryption ( 1.2.840.113549.1.1.11 )' : alg;
			this.certData.issuer.issuerCertUrl = ai.caissuer[0];
			this.certData.issuer.issuerOcspUrl = ai.ocsp[0];
			//noinspection JSUnresolvedVariable
			this.certData.notAfter             = (new Date(this.certData.validity.end)).toString();
			//noinspection JSUnresolvedVariable
			this.certData.notBefore            = (new Date(this.certData.validity.start)).toString();
		}
		catch (e) {
		}
	}

	/**
	 * @ignore
	 */
	async initCryptoKeys() {
		var ret = Promise.resolve(this);
		if (this.hasKey("X509")) {
			const readCertInfo = (resolve, reject) => pem.readCertificateInfo(this.getKey("X509") + "", (err, certData) => {
				if (this.fqdn && this.fqdn !== certData.commonName) {
					return reject(new Error(`Credentialing mismatch ${this.metadata} the common name in x509 does not match the metadata`));
				}
				
				this.certData = err ? null : certData;
				// console.log(`initCryptoKeys.readCertificateInfo - data read certData=${JSON.stringify(certData)}`)
				this.setExpirationStatus();
				//noinspection JSUnresolvedVariable
				this.fqdn               = this.extractCommonName();
				this.beameStoreServices = new BeameStoreDataServices(this.fqdn, this.store);
			
				this._updateCertData();
				return resolve(this);
			});
			ret = ret.then(() => new Promise(readCertInfo));
			const readPublicKey = (resolve, reject) => pem.getPublicKey(this.getKey("X509") + "", (err, publicKey) => {
					this.publicKeyStr     = publicKey.publicKey;
					this.publicKeyNodeRsa = new NodeRsa();
					try {
						this.publicKeyNodeRsa.importKey(this.publicKeyStr, "pkcs8-public-pem");						
					} catch (e) {
						console.log(`could not import services ${this.publicKeyStr}`)
						reject(new Error(`could not import services ${this.publicKeyStr}`))
					}
					return resolve(this);
				});
			ret = ret.then(()=> new Promise(readPublicKey))
		}
		if (this.hasKey("PRIVATE_KEY")) {
			this.privateKeyNodeRsa = new NodeRsa();
			this.privateKeyNodeRsa.importKey(this.getKey("PRIVATE_KEY") + " ", "private");
		}
		
		this._initPromise = ret;
		return ret;		
	}

	/**
	 * @ignore
	 * @param x509
	 * @param metadata
	 */
	initFromX509(x509, metadata) {
		pem.config({sync: true});
		pem.readCertificateInfo(x509, (err, certData) => {
			if (!err) {
				this.certData = certData;
				this.setExpirationStatus();
				this.beameStoreServices = new BeameStoreDataServices(certData.commonName, this.store);
				this.metadata.fqdn      = certData.commonName;
				//noinspection JSUnresolvedVariable
				this.fqdn               = certData.commonName;
				this.beameStoreServices.writeObject(Config.CertFileNames.X509, x509);
				this._updateCertData();
			}
			else {
				throw Error(err);
			}

		});
		pem.getPublicKey(x509, (err, publicKey) => {
			if (!err) {
				this.publicKeyStr     = publicKey.publicKey;
				this.publicKeyNodeRsa = new NodeRsa();
				try {
					this.publicKeyNodeRsa.importKey(this.publicKeyStr, "pkcs8-public-pem");
				} catch (e) {
					console.log(`Error could not import ${this.publicKeyStr}`);
				}
			}
			else {
				throw Error(err);
			}

		});
		this.parseMetadata(metadata);
		this.beameStoreServices.setFolder(this);
		this.beameStoreServices.writeMetadataSync(this.metadata);
		pem.config({sync: false});
	}

	/**
	 * @ignore
	 * @param pubKeyDerBase64
	 */
	initFromPubKeyDer64(pubKeyDerBase64) {
		this.publicKeyNodeRsa = new NodeRsa();
		this.publicKeyNodeRsa.importKey('-----BEGIN PUBLIC KEY-----\n' + pubKeyDerBase64 + '-----END PUBLIC KEY-----\n', "pkcs8-public-pem");
	}

	/**
	 * @ignore
	 * @param importCred
	 */
	initFromObject(importCred) {
		if (!importCred || !importCred.metadata) {
			return;
		}

		for (let key in Config.CertFileNames) {
			if (Config.CertFileNames.hasOwnProperty(key) && importCred.hasOwnProperty(key)) {
				this[key] = new Buffer(importCred[key]).toString();
			}

		}

		for (let key in Config.MetadataProperties) {
			//noinspection JSUnfilteredForInLoop
			let value = Config.MetadataProperties[key];
			if (importCred.metadata.hasOwnProperty(value)) {
				this.metadata[value] = importCred.metadata[value];
			}
		}
		this.initCryptoKeys();
		this.beameStoreServices.setFolder(this);
	}

//endregion

	//region Save/load services
	/**
	 * Delete Credential folder from Beame Store
	 * @public
	 * @method Credential.shred
	 * @param callback
	 */
	shred(callback) {
		this.beameStoreServices.deleteDir(callback);
	}

	/**
	 * @ignore
	 */
	saveCredentialsObject() {
		if (!this || !this.metadata || !this.metadata.path) {
			return;
		}

		Object.keys(Config.CertFileNames).forEach(keyName => {
			this[keyName] && this.beameStoreServices.writeObject(Config.CertFileNames[keyName], this[keyName]);
		});

		try {
			this.beameStoreServices.writeMetadataSync(this.metadata);
			//noinspection encies,nodemodulesdependencies
		} catch (e) {
			logger.debug("read cert data error " + e.toString());
		}
	}

	/**
	 * @ignore
	 */
	loadCredentialsObject() {
		Object.keys(Config.CertFileNames).forEach(keyName => {
			try {
				this[keyName] = this.beameStoreServices.readObject(Config.CertFileNames[keyName]);
			} catch (e) {
				//console.log(`exception ${e}`);
			}
		});

		try {
			let metadata = this.beameStoreServices.readMetadataSync();
			//noinspection es6modulesdependencies,nodemodulesdependencies
			_.map(metadata, (value, key) => {
				this.metadata[key] = value;
			});
		} catch (e) {
			logger.debug("read cert data error " + e.toString());
		}
	}

	//endregion

	//region GET and common helpers
	parseMetadata(metadata) {
		if (!_.isEmpty(metadata)) {
			_.map(metadata, (value, key) => {
				this.metadata[key] = value;
			});
		}
	}

//noinspection JSUnusedGlobalSymbols
	toJSON() {
		let ret = {
			metadata: {}
		};

		for (let key in Config.CertFileNames) {
			if (Config.CertFileNames.hasOwnProperty(key)) {
				ret[key] = this[key];
			}

		}

		for (let key in Config.MetadataProperties) {
			if (Config.MetadataProperties.hasOwnProperty(key)) {
				ret.metadata[Config.MetadataProperties[key]] = this.metadata[Config.MetadataProperties[key]];
			}
		}

		return ret;
	}

	getMetadataKey(field) {
		return this.metadata.hasOwnProperty(field.toLowerCase()) || this.metadata.hasOwnProperty(field) ? (this.metadata[field.toLowerCase()] || this.metadata[field]) : null;
	}

	hasMetadataKey(field) {
		let value = this.metadata.hasOwnProperty(field.toLowerCase()) || this.metadata.hasOwnProperty(field) ? (this.metadata[field.toLowerCase()] || this.metadata[field]) : null;

		return value != null && value != undefined;
	}

	hasKey(key) {
		//key = key.toLowerCase();
		return (this.hasOwnProperty(key) && !_.isEmpty(this[key])) || (this.hasOwnProperty(key.toLowerCase()) && !_.isEmpty(this[key.toLowerCase()]))
	}

	getKey(key) {
		//key = key.toLowerCase();
		return this.hasKey(key) ? (this[key] || this[key.toLowerCase()]) : null;
	}

//noinspection JSUnusedGlobalSymbols
	extractCommonName() {
		return CommonUtils.isObjectEmpty(this.certData) ? null : this.certData.commonName;
	}

	setExpirationStatus() {
		try {
			//noinspection JSUnresolvedVariable
			this.expired = CommonUtils.isObjectEmpty(this.certData) ? true : new Date(this.certData.validity.end) < new Date();
		} catch (e) {
			logger.error(`set expiration status error ${e}`, this.certData)
		}
	}

	getPublicKeyNodeRsa() {
		return this.publicKeyNodeRsa;
	}

	getPublicKeyDER64() {
		const pubKeyLines = this.publicKeyStr.split('\n');
		return pubKeyLines.slice(1, pubKeyLines.length - 1).join('\n');
	}

	getPrivateKeyNodeRsa() {
		return this.privateKeyNodeRsa;
	}

	getCertEnd() {

		try {
			//noinspection JSUnresolvedVariable
			return (new Date(this.certData.validity.end)).toLocaleString();
		} catch (e) {
			return null;
		}
	}

//endregion

	//region Crypto functions
	/**
	 * Sign given data with local Beame store Credential
	 * @public
	 * @method Credential.sign
	 * @param {String|Object} data
	 * @returns {SignatureToken|null}
	 */
	sign(data) {

		try {
			let message = {
				signedData: data,
				signedBy:   "",
				signature:  ""
			};

			if (this.hasKey("PRIVATE_KEY")) {
				message.signedBy = this.fqdn;
			}
			//noinspection ES6ModulesDependencies,NodeModulesDependencies,JSCheckFunctionSignatures
			message.signature = this.privateKeyNodeRsa.sign(message.signedData, "base64", "utf8");
			return message;
		} catch (e) {
			logger.error(`sign failed with ${BeameLogger.formatError(e)}`);
			return null;
		}
	}

	/**
	 * @public
	 * @method Credential.checkSignature
	 * @param {SignatureToken} data
	 * @returns {boolean}
	 */
	checkSignature(data) {
		let rsaKey = this.getPublicKeyNodeRsa();
		let status = rsaKey.verify(data.signedData, data.signature, "utf8", "base64");
		if (status) {
			logger.info(`Signature signed by ${data.signedBy} verified successfully`);
		}
		else {
			logger.warn(`Invalid signature signed by ${data.signedBy}`);
		}

		return status;
	}

	/**
	 * Create Auth token
	 * @ignore
	 * @param {String} signWithFqdn
	 * @param {String|null} [dataToSign]
	 * @param {Number|null|undefined} [ttl]
	 * @returns {Promise.<String|null>}
	 */
	signWithFqdn(signWithFqdn, dataToSign, ttl) {
		return new Promise((resolve, reject) => {
				if (!signWithFqdn) {
					reject('SignedWith FQDN parameter required');
					return;
				}
				//noinspection JSDeprecatedSymbols
				let signCred = this.store.getCredential(signWithFqdn);

				if (!signCred) {
					reject(`Credential ${signWithFqdn} not found in store`);
					return;
				}

				if (!signCred.hasKey("PRIVATE_KEY")) {
					reject(`Credential ${signWithFqdn} hasn't private key for signing`);
					return;
				}
				const AuthToken = require('./AuthToken');

				AuthToken.createAsync(dataToSign || Date.now(), signCred, ttl || 60 * 5).then(resolve).catch(error => {
					logger.error(error);
					reject(`Sign data failure, please see logs`);
				});
			}
		);

	}

	/**
	 * @public
	 * @method Credential.encryptWithRSA
	 * @param {String} data
	 * @returns {EncryptedMessage}
	 */
	encryptWithRSA(data) {
		let targetRsaKey = this.getPublicKeyNodeRsa();
		if (!targetRsaKey) {
			throw new Error("encrypt failure, public key not found");
		}
		return targetRsaKey.encrypt(data, "base64", "utf8");
	}

	/**
	 * @public
	 * @method Credential.encrypt
	 * @param {String} fqdn
	 * @param {String} data
	 * @param {String|null} [signingFqdn]
	 * @returns {EncryptedMessage}
	 */
	encrypt(fqdn, data, signingFqdn) {
		let signingCredential;
		if (signingFqdn) {
			//noinspection JSDeprecatedSymbols
			signingCredential = this.store.getCredential(signingFqdn);
		}

		let sharedCiphered = CryptoServices.aesEncrypt(data);

		//noinspection ES6ModulesDependencies,NodeModulesDependencies
		let symmetricCipherElement = JSON.stringify(sharedCiphered[1]);
		sharedCiphered[1]          = "";

		//noinspection ES6ModulesDependencies,NodeModulesDependencies
		/** @type {EncryptedMessage} */
		let encryptedUnsignedMessage = {
			rsaCipheredKeys: this.encryptWithRSA(symmetricCipherElement),
			data:            sharedCiphered[0],
			encryptedFor:    fqdn
		};
		if (signingCredential) {
			return signingCredential.sign(encryptedUnsignedMessage);
		}

		return encryptedUnsignedMessage;
	}

	/**
	 * @public
	 * @method Credential.decryptWithRSA
	 * @param {String} data
	 * @returns {EncryptedMessage}
	 */
	decryptWithRSA(data) {
		if (!this.hasKey("PRIVATE_KEY")) {
			throw new Error(`private key for ${this.fqdn} not found`);
		}
		let rsaKey = this.getPrivateKeyNodeRsa();

		return rsaKey.decrypt(data);
	}

	/**
	 * @public
	 * @method Credential.decrypt
	 * @param {Object} encryptedMessage
	 * @returns {*}
	 */
	decrypt(encryptedMessage) {

		if (encryptedMessage.signature) {
			//noinspection JSDeprecatedSymbols
			let signingCredential = this.store.getCredential(encryptedMessage.signedBy);

			if (!signingCredential) {
				throw new Error("Signing credential is not found in the local store");
			}

			if (!signingCredential.checkSignature({
					signedData: encryptedMessage.signedData,
					signedBy:   encryptedMessage.signedBy,
					signature:  encryptedMessage.signature
				})) {
				return null;
			}

			encryptedMessage = encryptedMessage.signedData;
		}

		let decryptedMessage = this.decryptWithRSA(encryptedMessage.rsaCipheredKeys);
		//noinspection ES6ModulesDependencies,NodeModulesDependencies,JSCheckFunctionSignatures
		let payload          = JSON.parse(decryptedMessage);

		let decipheredPayload = CryptoServices.aesDecrypt([
			encryptedMessage.data,
			payload,
		]);

		if (!decipheredPayload) {
			throw new Error("Decrypting, No message");
		}
		return decipheredPayload;
	}

//endregion

	//region Entity manage
	//region create entity

	/**
	 * Create entity service with local credentials
	 * @param {String} parent_fqdn => required
	 * @param {String|null} [name]
	 * @param {String|null} [email]
	 * @param {Number|null} [validityPeriod]
	 * @param {String|null} [password]
	 */
	createEntityWithLocalCreds(parent_fqdn, name, email, validityPeriod, password) {
		return new Promise((resolve, reject) => {
				if (!parent_fqdn) {
					reject('Parent Fqdn required');
					return;
				}
				//noinspection JSDeprecatedSymbols
				let parentCred = this.store.getCredential(parent_fqdn);

				if (!parentCred) {
					reject(`Parent credential ${parent_fqdn} not found`);
					return;
				}

				let metadata = {
					parent_fqdn,
					name,
					email
				};

				let postData = Credential.formatRegisterPostData(metadata),
				    apiData  = ProvisionApi.getApiData(apiEntityActions.RegisterEntity.endpoint, postData),
				    api      = new ProvisionApi();

				api.setClientCerts(parentCred.getKey("PRIVATE_KEY"), parentCred.getKey("P7B"));

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registering, parent_fqdn);

				//noinspection ES6ModulesDependencies,NodeModulesDependencies
				api.runRestfulAPI(apiData, (error, payload) => {
					if (error) {
						reject(error);
						return;
					}
					//set signature to consistent call of new credentials
					this.signWithFqdn(parent_fqdn, payload).then(authToken => {
						payload.sign = authToken;

						this._requestCerts(payload, metadata, validityPeriod, password).then(this._syncMetadataOnCertReceived.bind(this, payload.fqdn)).then(resolve).catch(reject);
					}).catch(reject);

				});
			}
		);
	}

	createVirtualEntity(parent_fqdn, name, email, password, validityPeriod) {
		return new Promise((resolve, reject) => {
				if (!parent_fqdn) {
					reject('Parent Fqdn required');
					return;
				}
				//noinspection JSDeprecatedSymbols
				let parentCred = this.store.getCredential(parent_fqdn);

				if (!parentCred) {
					reject(`Parent credential ${parent_fqdn} not found`);
					return;
				}

				let metadata;

				metadata = {
					parent_fqdn,
					name,
					email
				};

				let postData = Credential.formatRegisterPostData(metadata),
				    apiData  = ProvisionApi.getApiData(apiEntityActions.RegisterEntity.endpoint, postData),
				    api      = new ProvisionApi();

				api.setClientCerts(parentCred.getKey("PRIVATE_KEY"), parentCred.getKey("P7B"));

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registering, parent_fqdn);

				//noinspection ES6ModulesDependencies,NodeModulesDependencies
				api.runRestfulAPI(apiData, (error, payload) => {
					if (error) {
						reject(error);
						return;
					}
					//set signature to consistent call of new credentials
					this.signWithFqdn(parent_fqdn, payload).then(authToken => {
						payload.sign = authToken;

						this._requestVirtualCerts(payload, password, validityPeriod).then(payload => {
							resolve(payload);
						}).catch(reject);


					}).catch(reject);

				});

			}
		);
	}

//noinspection JSUnusedGlobalSymbols
	createCustomEntityWithLocalCreds(parent_fqdn, custom_fqdn, name, email, validityPeriod) {
		return new Promise((resolve, reject) => {
				if (!parent_fqdn) {
					reject('Parent Fqdn required');
					return;
				}
				//noinspection JSDeprecatedSymbols
				let parentCred = this.store.getCredential(parent_fqdn);

				if (!parentCred) {
					reject(`Parent credential ${parent_fqdn} not found`);
					return;
				}

				let metadata = {
					parent_fqdn,
					name,
					email,
					custom_fqdn: custom_fqdn
				};

				let postData = Credential.formatRegisterPostData(metadata),
				    apiData  = ProvisionApi.getApiData(apiEntityActions.RegisterEntity.endpoint, postData),
				    api      = new ProvisionApi();

				api.setClientCerts(parentCred.getKey("PRIVATE_KEY"), parentCred.getKey("P7B"));

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registering, parent_fqdn);

				//noinspection ES6ModulesDependencies,NodeModulesDependencies
				api.runRestfulAPI(apiData, (error, payload) => {
					if (error) {
						reject(error);
						return;
					}
					//set signature to consistent call of new credentials
					this.signWithFqdn(parent_fqdn, payload).then(authToken => {
						payload.sign = authToken;

						this._requestCerts(payload, metadata, validityPeriod).then(this._syncMetadataOnCertReceived.bind(this, payload.fqdn)).then(resolve).catch(reject);
					}).catch(reject);

				});
			}
		);
	}

	/**
	 * Create entity service with local credentials
	 * @param {String} parent_fqdn => required
	 * @param {String|null} [name]
	 * @param {String|null} [email]
	 * @param {String|null} [src]
	 * @param {String|null} [serviceName]
	 * @param {String|null} [serviceId]
	 * @param {String|null} [matchingFqdn]
	 */
	createRegistrationWithLocalCreds(parent_fqdn, name, email, src, serviceName, serviceId, matchingFqdn) {
		return new Promise((resolve, reject) => {
				if (!parent_fqdn) {
					reject('Parent Fqdn required');
					return;
				}
				//noinspection JSDeprecatedSymbols
				let parentCred = this.store.getCredential(parent_fqdn);

				if (!parentCred) {
					reject(`Parent credential ${parent_fqdn} not found`);
					return;
				}


				let metadata = {
					parent_fqdn,
					name,
					email,
					serviceName,
					serviceId,
					matchingFqdn,
					src: src || Config.RegistrationSource.Unknown
				};

				let postData = Credential.formatRegisterPostData(metadata),
				    apiData  = ProvisionApi.getApiData(apiEntityActions.RegisterEntity.endpoint, postData),
				    api      = new ProvisionApi();

				api.setClientCerts(parentCred.getKey("PRIVATE_KEY"), parentCred.getKey("P7B"));

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registering, parent_fqdn);

				//noinspection ES6ModulesDependencies,NodeModulesDependencies
				api.runRestfulAPI(apiData, (error, payload) => {
					if (error) {
						reject(error);
						return;
					}

					if (src) {
						payload.src = src;
					}

					resolve({
						parentCred,
						payload
					});

				});

			}
		);
	}

	/**
	 * @ignore
	 * @param {String} authToken
	 * @param {String|null} [authSrvFqdn]
	 * @param {String|null} [name]
	 * @param {String|null} [email]
	 * @param {Number|null} [validityPeriod]
	 */
	createEntityWithAuthServer(authToken, authSrvFqdn, name, email, validityPeriod) {
		return new Promise((resolve, reject) => {

				if (!authToken) {
					reject('Auth token required');
					return;
				}

				logger.debug("createEntityWithAuthServer(): Selecting proxy");

				/**
				 * @param error
				 * @param payload
				 * @this {Credential}
				 */
				const fqdnResponseReady = (error, payload) => {
					logger.debug("createEntityWithAuthServer(): fqdnResponseReady", payload);
					if (error) {
						reject(error);
						return;
					}

					logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registered, payload.fqdn);

					this._requestCerts(payload, metadata, validityPeriod).then(this._syncMetadataOnCertReceived.bind(this, payload.fqdn)).then(resolve).catch(reject);
				};

				logger.debug("createEntityWithAuthServer(): onEdgeServerSelected");

				let authServerFqdn = (authSrvFqdn && 'https://' + authSrvFqdn) || Config.SelectedProfile.AuthServerURL;

				let metadata = {
					name,
					email
				};
				let api      = new ProvisionApi();

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registering, authServerFqdn);

				api.postRequest(
					authServerFqdn + apiAuthServerActions.RegisterEntity.endpoint,
					Credential.formatRegisterPostData(metadata),
					fqdnResponseReady.bind(this),
					authToken,
					5
				);

			}
		);

	}

	/**
	 * @ignore
	 * @param {String} authToken
	 * @param {String|null} [name]
	 * @param {String|null} [email]
	 * @param {Number|null} [validityPeriod]
	 * @returns {Promise}
	 */
	createEntityWithAuthToken(authToken, name, email, validityPeriod) {
		return new Promise((resolve, reject) => {

				if (!authToken) {
					reject('Auth token required');
					return;
				}

				let tokenObj = CommonUtils.parse(authToken);

				if (!tokenObj) {
					reject('Invalid Auth token');
					return;
				}

				logger.debug("createEntityWithAuthToken(): Selecting proxy");

				/**
				 * @param error
				 * @param payload
				 * @this {Credential}
				 */
				const fqdnResponseReady = (error, payload) => {
					logger.debug("createEntityWithAuthServer(): fqdnResponseReady");
					if (error) {
						reject(error);
						return;
					}

					logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registered, payload.fqdn);

					payload.sign = authToken;

					this._requestCerts(payload, metadata, validityPeriod).then(this._syncMetadataOnCertReceived.bind(this, payload.fqdn)).then(resolve).catch(reject);

				};

				let metadata = {
					name,
					email,
					parent_fqdn: tokenObj.signedBy
				};

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.Registering, metadata.parent_fqdn);

				let postData = Credential.formatRegisterPostData(metadata),
				    apiData  = ProvisionApi.getApiData(apiEntityActions.RegisterEntity.endpoint, postData),
				    api      = new ProvisionApi();

				api.runRestfulAPI(apiData,
					fqdnResponseReady.bind(this),
					'POST',
					authToken
				);

			}
		);

	}

	createEntityWithRegistrationToken(token, validityPeriod) {
		let type = token.type || Config.RequestType.RequestWithAuthServer;

		switch (type) {
			case Config.RequestType.RequestWithAuthServer:
				//noinspection JSCheckFunctionSignatures
				return this.createEntityWithAuthServer(token.authToken, token.authSrvFqdn, token.name, token.email, validityPeriod);
			case Config.RequestType.RequestWithParentFqdn:
				return this.createEntityWithAuthToken(token.authToken, token.name, token.email, validityPeriod);
			case Config.RequestType.RequestWithFqdn:

				//noinspection JSUnresolvedVariable
				let aut        = CommonUtils.parse(token.authToken),
				    signedData = CommonUtils.parse(aut.signedData.data),
				    payload    = {
					    fqdn:        signedData.fqdn,
					    parent_fqdn: aut.signedBy,
					    sign:        token.authToken
				    },
				    metadata   = {
					    name:  token.name,
					    email: token.email
				    };

				return this.requestCerts(payload, metadata, validityPeriod);
			default:
				return Promise.reject(`Unknown request type`);
		}
	}

	/**
	 * Create registration token for child of given fqdn
	 * @param {RegistrationTokenOptionsToken} options
	 * @returns {Promise}
	 */
	createRegistrationToken(options) {

		return new Promise((resolve, reject) => {

				const AuthToken = require('./AuthToken');

				this.createRegistrationWithLocalCreds(options.fqdn, options.name, options.email, options.src, options.serviceName, options.serviceId, options.matchingFqdn).then(data => {

					let payload     = data.payload,
					    parent_cred = data.parentCred;


					AuthToken.createAsync({fqdn: payload.fqdn}, parent_cred, options.ttl || 60 * 60 * 24 * 2).then(authToken => {
						let token = {
							    authToken: authToken,
							    name:      options.name,
							    email:     options.email,
							    type:      Config.RequestType.RequestWithFqdn
						    },
						    str   = new Buffer(CommonUtils.stringify(token, false)).toString('base64');

						resolve(str);
					}).catch(reject);

				}).catch(reject);
			}
		);

	}

//noinspection JSUnusedGlobalSymbols
	/**
	 * Create registration token for child of given fqdn
	 * @param {RegistrationTokenOptionsToken} options
	 * @returns {Promise}
	 */
	createMobileRegistrationToken(options) {

		return new Promise((resolve, reject) => {

				const AuthToken = require('./AuthToken');

				this.createRegistrationWithLocalCreds(options.fqdn, options.name, options.email, options.src, options.serviceName, options.serviceId, options.matchingFqdn).then(data => {

					let payload     = data.payload,
					    parent_cred = data.parentCred;

					AuthToken.createAsync({fqdn: payload.fqdn}, parent_cred, options.ttl || 60 * 60 * 24 * 2).then(authToken => {
						let token = {
							    authToken:     authToken,
							    name:          options.name,
							    email:         options.email,
							    usrId:         options.userId,
							    src:           options.src,
							    level:         payload.level,
							    serviceName:   options.serviceName,
							    serviceId:     options.serviceId,
							    matchingFqdn:  options.matchingFqdn,
							    type:          Config.RequestType.RequestWithFqdn,
							    imageRequired: options.imageRequired,
							    gwFqdn:        options.gwFqdn
						    },
						    str   = new Buffer(CommonUtils.stringify(token, false)).toString('base64');

						resolve(str);

					}).catch(reject);

				}).catch(reject);
			}
		);

	}

//noinspection JSUnusedGlobalSymbols
	createAuthTokenForCred(fqdn, data2Sign = null, ttl = null) {

		const AuthToken = require('./AuthToken');

		return new Promise((resolve, reject) => {
				let cred = this.store.getCredential(fqdn);

				if (!cred) {
					reject(`Cred not found for ${fqdn}`);
					return;
				}

				if (!cred.expired && cred.hasKey("PRIVATE_KEY")) {
					AuthToken.createAsync(data2Sign || {fqdn}, cred, ttl).then(resolve).catch(reject);
				}
				else {
					let parents = this.getParentsChain(null, fqdn);

					if (!parents.length) {
						reject(`Cred ${fqdn} expired. Parent credential not found`);
						return;
					}

					let validParents = parents.filter(x => x.hasPrivateKey === true && !x.expired).sort((a, b) => {
						return b.level - a.level;
					});

					if (!validParents.length) {
						reject(`Cred ${fqdn} expired.Valid parent credential not found`);
						return;
					}

					let approverFqdn = validParents[0].fqdn,
					    approverCred = this.store.getCredential(approverFqdn);

					AuthToken.createAsync(data2Sign || {fqdn}, approverCred, ttl).then(resolve).catch(reject);

				}
			}
		);
	}

//endregion

	//region certs

	// /**
	//  *  @ignore
	//  * @returns {Promise.<String>}
	//  */
// createCSR(cred, dirPath) {
//
// 	const fqdn       = this.fqdn,
// 	      pkFileName = Config.CertFileNames.PRIVATE_KEY;
//
// 	return new Promise(function (resolve, reject) {
//
// 		cred._createInitialKeyPairs(dirPath).then(() => {
// 			let pkFile = beameUtils.makePath(dirPath, pkFileName);
// 			openSSlWrapper.createCSR(fqdn, pkFile).then(resolve).catch(reject);
// 		}).catch(reject);
//
// 	});
// }

	/**
	 * @ignore
	 * @param {SignatureToken} authToken
	 * @param {Object} pubKeys
	 * @param {RequestCertOptions} options
	 */
	getCert(authToken, pubKeys, options) {
		let fqdn = this.fqdn;


		return new Promise((resolve, reject) => {
				let postData  = {
					    fqdn:     fqdn,
					    validity: options.validityPeriod || Config.defaultValidityPeriod,
					    pub:      pubKeys
				    },
				    saveCerts = options.saveCerts || true,
				    api       = new ProvisionApi(),
				    apiData   = ProvisionApi.getApiData(apiEntityActions.CompleteRegistration.endpoint, postData);

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.RequestingCerts, fqdn);

				//noinspection ES6ModulesDependencies,NodeModulesDependencies
				api.runRestfulAPI(apiData, (error, payload) => {

					if (error) {
						reject(error);
						return;
					}

					if (saveCerts) {
						this._saveCerts(error, payload, options.password).then(resolve).catch(reject);
					}
					else {
						resolve(payload);
					}
				}, 'POST', JSON.stringify(authToken));
			}
		);
	}

	requestCerts(payload, metadata, validityPeriod) {
		return new Promise((resolve, reject) => {

				this._requestCerts(payload, metadata, validityPeriod).then(this._syncMetadataOnCertReceived.bind(this, payload.fqdn)).then(resolve).catch(reject);
			}
		);
	}

	revokeCert(signerAuthToken, signerFqdn, revokeFqdn) {
		return new Promise((resolve, reject) => {
				const api = new ProvisionApi();

				let postData = {
					    fqdn: revokeFqdn
				    },
				    apiData  = ProvisionApi.getApiData(apiEntityActions.CertRevoke.endpoint, postData);

				let authToken = null;

				if (!signerAuthToken) {
					let cred = this.store.getCredential(signerFqdn);
					if (!cred) {
						reject(`Signer cred for ${signerFqdn} not found`);
						return;
					}
					api.setClientCerts(cred.getKey("PRIVATE_KEY"), cred.getKey("P7B"));
				}
				else {
					authToken = CommonUtils.stringify(signerAuthToken, false);
				}

				const _onApiResponse = (error) => {
					if (error) {
						reject(error);
						return;
					}

					let revokedCred = this.store.getCredential(revokeFqdn);

					if (revokedCred && revokedCred.hasKey("X509")) {
						revokedCred.saveOcspStatus(true);
					}

					Credential.saveCredAction(revokedCred, {
						action: Config.CredAction.Revoke,
						date:   Date.now()
					});

					storeCacheServices.saveRevocation(revokeFqdn).then(()=>{
						resolve({message: `${revokeFqdn} Certificate has been revoked successfully`});
					});
				};

				api.runRestfulAPI(apiData, _onApiResponse, 'POST', authToken);
			}
		);
	}

	/**
	 * @param {String|null|undefined} [signerAuthToken]
	 * @param {String} fqdn
	 * @param {Number|null|undefined} [validityPeriod]
	 * @returns {Promise}
	 */
	renewCert(signerAuthToken, fqdn, validityPeriod) {
		return new Promise((resolve, reject) => {

				let cred = this.store.getCredential(fqdn);

				if (cred == null) {
					reject(`Credential ${fqdn} not found`);
					return;
				}

				if (!cred.hasKey("PRIVATE_KEY")) {
					reject(`Private key not found for ${fqdn}`);
					return;
				}

				function make() {
					let dirPath = cred.getMetadataKey("path");

					const _renew = () => {

						OpenSSLWrapper.getPublicKeySignature(DirectoryServices.readFile(beameUtils.makePath(dirPath, Config.CertFileNames.PRIVATE_KEY))).then(signature => {

							let pubKeys = {
								pub:    DirectoryServices.readFile(beameUtils.makePath(dirPath, Config.CertFileNames.PUBLIC_KEY)),
								pub_bk: DirectoryServices.readFile(beameUtils.makePath(dirPath, Config.CertFileNames.BACKUP_PUBLIC_KEY)),
								signature
							};

							let postData = {
								    fqdn:     fqdn,
								    validity: validityPeriod || Config.defaultValidityPeriod,
								    pub:      pubKeys
							    },
							    api      = new ProvisionApi(),
							    apiData  = ProvisionApi.getApiData(apiEntityActions.CertRenew.endpoint, postData);

							logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.RequestingCerts, fqdn);

							let authToken = null;

							if (!signerAuthToken) {
								api.setClientCerts(cred.getKey("PRIVATE_KEY"), cred.getKey("P7B"));
							}
							else {
								authToken = (typeof signerAuthToken === 'object') ? CommonUtils.stringify(signerAuthToken, false) : signerAuthToken;
							}


							api.runRestfulAPI(apiData, (error, payload) => {
								cred._saveCerts(error, payload).then(certs => {
									Credential.saveCredAction(cred, {
										action: Config.CredAction.Renew,
										date:   Date.now()
									});
									storeCacheServices.updateCertData(cred.fqdn, cred.certData)
										.then(() => {
												resolve(certs)
											}
										);
								}).catch(reject);
							}, 'POST', authToken);
						}).catch(reject);

					};

					//check if public key exists (old API)
					const path = require('path');

					let publicExists = DirectoryServices.doesPathExists(path.join(dirPath, Config.CertFileNames.PUBLIC_KEY));

					if (publicExists) {
						_renew();
					}
					else {

						//noinspection JSUnresolvedFunction
						async.parallel([
								cb => {
									//create public key for existing private
									let pkFile  = beameUtils.makePath(dirPath, Config.CertFileNames.PRIVATE_KEY),
									    pubFile = beameUtils.makePath(dirPath, Config.CertFileNames.PUBLIC_KEY);

									openSSlWrapper.savePublicKey(pkFile, pubFile).then(() => {
										cb();
									}).catch(error => {
										cb(error)
									});
								},
								cb => {
									//create backup key pair
									openSSlWrapper.createPrivateKey().then(pk =>
										DirectoryServices.saveFile(dirPath, Config.CertFileNames.BACKUP_PRIVATE_KEY, pk, error => {
											if (!error) {
												let pkFile  = beameUtils.makePath(dirPath, Config.CertFileNames.BACKUP_PRIVATE_KEY),
												    pubFile = beameUtils.makePath(dirPath, Config.CertFileNames.BACKUP_PUBLIC_KEY);
												openSSlWrapper.savePublicKey(pkFile, pubFile).then(() => {
													cb(null);
												}).catch(error => {
													cb(error)
												});
											}
											else {
												let errMsg = logger.formatErrorMessage("Failed to save Private Key", module_name, {"error": error}, Config.MessageCodes.OpenSSLError);
												cb(errMsg);
											}
										})
									).catch(error => {
										cb(error);
									});
								}
							],
							error => {
								if (error) {
									logger.error(`generating keys error ${BeameLogger.formatError(error)}`);
									reject(error);
								}

								_renew();
							});

					}
				}

				if (!signerAuthToken) {
					const store = new (require("./BeameStoreV2"))();

					/** @type {FetchCredChainOptions}**/
					let cred_options = {
						highestFqdn:null,
						allowRevoked:true,
						allowExpired:true,
						allowApprovers: true
					};

					store.fetchCredChain(fqdn, cred_options, (err, creds) => {
						if (!err) {
							let signerCred = null;
							for (let i = 0; i < creds.length; i++) {
								if (creds[i].hasKey('PRIVATE_KEY') && !creds[i].expired && !creds[i].metadata.revoked) {
									if (creds[i].certData.notAfter) {
										signerCred = creds[i];
										break;
									}
									else {
										creds[i]._updateCertData();
										if (creds[i].notAfter && (Number(creds[i].notAfter) - Date.now() > 300)) {
											signerCred = creds[i];
											break;
										}
									}
								}
							}
							if (signerCred) {
								signerCred.signWithFqdn(signerCred.fqdn, fqdn).then((token) => {
									signerAuthToken = token;
									make();
									// _renew(new Buffer(token).toString('base64'), fqdn, true);
								}).catch(e => {
									logger.error(`Failed to create token with cred ${signerCred.fqdn}::${BeameLogger.formatError(e)}`);
								});
							}
							else {
								const AuthToken  = require('./AuthToken');
								let authToken    = AuthToken.create(creds[0].fqdn, creds[0], undefined, true);
								let nPredecessor = 0;
								let api          = new ProvisionApi();

								let requestRenewToken = () => {
									const retryGetToken = (err) => {
										if (err) logger.debug(err);
										if (++nPredecessor < creds.length) {
											requestRenewToken();
										}
										else{
											let errMsg = logger.formatErrorMessage(`Failed to find valid signer cred for ${fqdn}`, module_name, {"fqdn": fqdn}, Config.MessageCodes.SignerNotFound);

											reject(errMsg);
										}
									};

									// noinspection JSUnresolvedVariable
									let parent = creds[nPredecessor].parent_fqdn ? creds[nPredecessor].parent_fqdn :
										(creds[nPredecessor].parent && creds[nPredecessor].parent.fqdn) ? creds[nPredecessor].parent.fqdn :
											creds[nPredecessor].approved_by_fqdn;
									if (parent) {
										api.makeGetRequest('https://' + parent + '/cert-renew', null, (err, data) => {
											if (!err && data && data.regToken) {
												signerAuthToken = data.regToken;
												make();
											}
											else retryGetToken(err);
										}, authToken, 3);
									}
									else retryGetToken('Picking next parent');
								};

								requestRenewToken();
							}
						}
						else {
							reject('Failed to fetch cred chain: ' + err);
						}

					})
				}
				else make();

			}
		);
	}

	saveOcspStatus(isRevoked) {
		this.metadata.revoked = isRevoked;
		this.beameStoreServices.writeMetadataSync(this.metadata);
	};

	updateOcspStatus() {

		return new Promise((resolve) => {
				if (this.hasMetadataKey("revoked")) {
					resolve(this);
					return;
				}

				this.checkOcspStatus(this).then(status => {
					this.saveOcspStatus(status === Config.OcspStatus.Bad);
					resolve(this);
				})
			}
		);
	}

	checkOcspStatus(cred, forceCheck = false) {
		return new Promise((resolve) => {

				let ignoreOcsp = !!(process.env.BEAME_OCSP_IGNORE);

				if (ignoreOcsp) {
					resolve(Config.OcspStatus.Good);
					return;
				}


				if (!forceCheck) {
					storeCacheServices.getOcspStatus(cred.fqdn).then(resolve)
				}
				else {
					const _resolve = (status, error) => {
						if (error) {
							logger.error(`Error ${BeameLogger.formatError(error)} on OCSP check for ${cred.fqdn}`);
						}

						cred.metadata.ocspStatus = {
							status: status,
							date:   Date.now()
						};

						cred.metadata.revoked = status === Config.OcspStatus.Bad;

						cred.beameStoreServices.writeMetadataSync(cred.metadata);

						Credential.saveCredAction(cred, {
							action: Config.CredAction.OcspUpdate,
							date:   Date.now()
						});

						resolve(status);
					};


					if (process.env.EXTERNAL_OCSP_FQDN) {

						const AuthToken = require('./AuthToken');
						const request   = require('request');

						const _generateOcspRequest = () => {
							return new Promise((resolve, reject) => {
									this.generateOcspRequest(cred).then(req => {
										ocspUtils.getOcspUri(cred.getKey("X509")).then(uri => {
											resolve([req, uri])
										}).catch(reject)
									}).catch(reject)
								}
							);
						};

						const _getSignerCred = (fqdn, [req, uri]) => {
							return new Promise((resolve, reject) => {

									/** @type {FetchCredChainOptions}**/
									let cred_options = {
										highestFqdn:null,
										allowRevoked:true,
										allowExpired:true,
										allowApprovers: true
									};
									const store = require("./BeameStoreV2").getInstance();
									store.fetchCredChain(fqdn, cred_options, (err, creds) => {
										if (!err) {
											let signerCred = null;
											for (let i = 0; i < creds.length; i++) {
												if (creds[i].hasKey('PRIVATE_KEY') && !creds[i].expired && !creds[i].metadata.revoked) {
													signerCred = creds[i];
													break;
												}
											}
											if (signerCred) {
												resolve([signerCred, req, uri]);
											}
											else {
												reject(`Failed to find valid signer cred for ${fqdn}`);
											}
										}
										else {
											reject('Failed to fetch cred chain: ' + err);
										}
									});
								}
							);
						};

						const _doOcspProxyRequest = ([signerCred, req, ocspUri]) => {
							return new Promise((resolve, reject) => {

									let digest    = CommonUtils.generateDigest(req.data, 'sha256', 'base64');
									let authToken = AuthToken.create(digest, signerCred);

									if (authToken == null) {
										reject(`Auth token create for ${signerCred.fqdn}  failed`);
										return;
									}

									const url = `https://${process.env.EXTERNAL_OCSP_FQDN}${actionsApi.OcspApi.Check.endpoint}`;

									let opt = {
										url:      url,
										headers:  {
											'X-BeameAuthToken': authToken,
											'X-BeameOcspUri':   ocspUri,
											'Content-Type':     'application/ocsp-request',
											'Content-Length':   req.data.length

										},
										method:   'POST',
										body:     req.data,
										encoding: null
									};

									request(opt, (error, response, body) => {
										if (!response || response.statusCode < 200 || response.statusCode >= 400) {
											resolve(Config.OcspStatus.Unavailable);
										}
										else {

											ocspUtils.verify(cred.fqdn, req, body).then(status => {
												storeCacheServices.setOcspStatus(cred.fqdn, status).then(()=>{
													resolve(status)
												});

											})
										}
									});
								}
							);
						};

						_generateOcspRequest()
							.then(_getSignerCred.bind(null, cred.fqdn))
							.then(_doOcspProxyRequest)
							.then(_resolve)
							.catch(e => {
								logger.error(`Get ocsp status for on ${process.env.EXTERNAL_OCSP_FQDN} for ${cred.fqdn} error ${BeameLogger.formatError(e)}`);
								_resolve(Config.OcspStatus.Unavailable, e);
							});
					}
					else {
						if (cred.hasKey("X509")) {
							this.doOcspRequest(cred).then(_resolve);
						}
						else {
							_resolve(Config.OcspStatus.Unknown, `Cred ${cred.fqdn} has not certificate`);
						}

					}
				}
			}
		);
	}

	doOcspRequest(cred) {
		return new Promise((resolve) => {

				this._assertIssuerCert(cred)
					.then(issuerPemPath => {
						return new Promise((resolve) => {
								ocspUtils.check(cred.fqdn, cred.getKey("X509"), issuerPemPath).then(status => {
									storeCacheServices.setOcspStatus(cred.fqdn, status).then(()=>{
										resolve(status);
									});
								});
							}
						);
					})
					.then(resolve)
					.catch(e => {
						logger.error(`Check ocsp status local for ${cred.fqdn} error ${BeameLogger.formatError(e)}`);
						resolve(Config.OcspStatus.Unavailable);
					});
			}
		);
	}

	_assertIssuerCert(cred) {

		const request = require('request');
		const fs      = require('fs');
		const path    = require('path');

		if (!cred.hasKey("X509")) {
			return Promise.reject(`Credential ${cred.fqdn} hasn't X509 certificate`);
		}

		return new Promise((resolve, reject) => {

				let issuerCertUrl = cred.certData.issuer.issuerCertUrl;

				if (!issuerCertUrl) {

					reject(new Error(`No Issuer CA Cert url found`));
					return;
				}

				let certName = issuerCertUrl.substring(issuerCertUrl.lastIndexOf('/') + 1),
				    certPath = path.join(Config.issuerCertsPath, certName),
				    pemPath  = path.join(Config.issuerCertsPath, `${certName.substring(0, certName.lastIndexOf('.'))}.pem`);


				if (DirectoryServices.doesPathExists(pemPath)) {
					resolve(pemPath);
				}
				else {

					if (!DirectoryServices.doesPathExists(Config.issuerCertsPath)) {
						DirectoryServices.createDir(Config.issuerCertsPath);
					}

					const _onCertReceived = (body) => {
						fs.writeFileSync(certPath, body);

						OpenSSLWrapper.convertCertToPem(certPath, pemPath).then(() => {
							fs.unlinkSync(certPath);
							resolve(pemPath);
						}).catch(e => {
							reject(e);
						})
					};


					if (process.env.EXTERNAL_OCSP_FQDN) {
						const AuthToken = require('./AuthToken');

						const url = `https://${process.env.EXTERNAL_OCSP_FQDN}${actionsApi.OcspApi.HttpGetProxy.endpoint}`;

						let authToken = AuthToken.create(cred.fqdn, cred);

						if (authToken == null) {
							reject(`Auth token create for ${cred.fqdn}  failed`);
							return;
						}

						let opt = {
							url:     url,
							headers: {
								'X-BeameAuthToken': authToken,
								'Content-Type':     'application/json'

							},
							method:  'GET',
							body:    CommonUtils.stringify({url: issuerCertUrl})
						};

						request(opt, (error, response, body) => {
							if (response.statusCode < 200 || response.statusCode >= 400) {
								logger.error(`Get issuer CA error ${error} status ${response.statusCode} on ${issuerCertUrl}`);
								reject(`Get issuer CA error ${error} status ${response.statusCode}`);
							}
							else {
								_onCertReceived(body);
							}

						});
					}
					else {
						request.get(
							issuerCertUrl,
							{encoding: null},
							(error, response, body) => {
								if (!error && response.statusCode === 200) {

									_onCertReceived(body);
								}
								else {
									logger.error(`Get issuer CA error ${error} status ${response.statusCode} on ${issuerCertUrl}`);
									reject(`Get issuer CA error ${error} status ${response.statusCode}`);
								}
							}
						);
					}

				}
			}
		);
	}

	generateOcspRequest(cred) {

		return new Promise((resolve, reject) => {

				this._assertIssuerCert(cred).then(pemPath => {

					let req = ocspUtils.generateOcspRequest(cred.fqdn, cred.getKey("X509"), pemPath);

					req ? resolve(req) : reject(`Ocsp request generation failed`);

				}).catch(reject);
			}
		);


	}

//endregion

	//region metadata
	/**
	 *
	 * @param fqdn
	 * @returns {Promise}
	 */
	syncMetadata(fqdn) {

		return new Promise((resolve, reject) => {
				this.getMetadata(fqdn).then(payload => {
					//noinspection JSDeprecatedSymbols
					let cred = this.store.getCredential(fqdn);

					if (!cred) {
						reject(`Creds for ${fqdn} not found`);
						return;
					}

					cred.beameStoreServices.writeMetadataSync(payload);
					resolve(payload);

				}).catch(reject);
			}
		);
	}

	/**
	 * @ignore
	 * @param {String} fqdn
	 * @returns {Promise}
	 */
	getMetadata(fqdn) {

		return new Promise((resolve, reject) => {
//noinspection JSDeprecatedSymbols
				let cred = this.store.getCredential(fqdn);

				if (!cred) {
					reject(`Creds for ${fqdn} not found`);
					return;
				}

				const api     = new ProvisionApi(),
				      apiData = ProvisionApi.getApiData(apiEntityActions.GetMetadata.endpoint, {});

				api.setClientCerts(cred.getKey("PRIVATE_KEY"), cred.getKey("P7B"));

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.UpdatingMetadata, fqdn);

				api.runRestfulAPI(apiData, (error, metadata) => {
					if (!error) {
						logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.MetadataUpdated, fqdn);
						resolve(metadata);
					}
					else {
						logger.error(`Updating metadata for ${fqdn} failed`, error);
						reject(error);
					}
				}, 'GET');
			}
		);
	}

	/**
	 * Update Entity metadata: name or email
	 * @public
	 * @method Credential.updateMetadata
	 * @param {String} fqdn
	 * @param {String|null} [name]
	 * @param {String|null} [email]
	 * @returns {Promise}
	 */
	updateMetadata(fqdn, name, email) {
		return new Promise((resolve, reject) => {
//noinspection JSDeprecatedSymbols
				let cred = this.store.getCredential(fqdn);

				if (!cred) {
					reject(`Creds for ${fqdn} not found`);
					return;
				}

				const api = new ProvisionApi();

				let postData = {
					    name,
					    email
				    },
				    apiData  = ProvisionApi.getApiData(apiEntityActions.UpdateEntity.endpoint, postData);

				api.setClientCerts(cred.getKey("PRIVATE_KEY"), cred.getKey("P7B"));

				//noinspection ES6ModulesDependencies,NodeModulesDependencies
				api.runRestfulAPI(apiData, (error) => {
					if (error) {
						reject(error);
						return;
					}
					//set signature to consistent call of new credentials
					cred.syncMetadata(fqdn).then(resolve).catch(reject);

				});
			}
		);
	}

//endregion

	//region dns service
//noinspection JSUnusedGlobalSymbols
	/**
	 *
	 * @param {String} fqdn
	 * @param {String|null|undefined} [value]
	 * @param {Boolean|null|undefined} [useBestProxy]
	 * @param {String|null|undefined} [dnsFqdn] => could be different from fqdn in case of local ip
	 */
	setDns(fqdn, value, useBestProxy, dnsFqdn) {

		debug_dns(`Credential#setDns() fqdn=${fqdn} value=${value} useBestProxy=${useBestProxy} dnsFqdn=${dnsFqdn}`);

		return new Promise((resolve, reject) => {

				if (!fqdn) {
					reject('FQDN required');
					return;
				}

				if (!value && !useBestProxy) {
					reject('value required');
					return;
				}

				this.store.find(fqdn, false).then(cred => {
					let val = null;

					const DnsServices = require('./DnsServices');

					const _setDns = () => {
						return DnsServices.setDns(fqdn, val, dnsFqdn);
					};

					const _updateEntityMeta = () => {

						Credential._updateDnsRecords(cred, dnsFqdn || fqdn, {
							fqdn:  dnsFqdn || fqdn,
							value: val,
							date:  Date.now()
						});

						return Promise.resolve(val);
					};

					const _resolve = () => {

						Credential.saveCredAction(cred, {
							action: Config.CredAction.DnsSaved,
							fqdn:   dnsFqdn || fqdn,
							value:  value,
							date:   Date.now()
						});

						resolve(val);
					};

					const _runSequence = () => {
						_setDns(val)
							.then(_updateEntityMeta)
							.then(_resolve)
							.catch(reject)
					};

					if (useBestProxy) {

						if (process.env.BEAME_FORCE_EDGE_FQDN) {
							val = process.env.BEAME_FORCE_EDGE_FQDN;
							_runSequence();
						}
						else {
							this._selectEdge()
								.then(edge => {
									val = edge.endpoint;
									_runSequence();
								})
						}
					}
					else {
						val = value;
						_runSequence();
					}
				}).catch(reject);

			}
		);
	}

	/**
	 * Delete Dns record
	 * @param {String} fqdn
	 * @param {String|null|undefined} [dnsFqdn] => could be different from fqdn in case of local ip
	 * @returns {Promise}
	 */
	deleteDns(fqdn, dnsFqdn) {
		return new Promise((resolve, reject) => {

				this.store.find(fqdn, false).then(cred => {

					const _deleteDns = () => {
						const DnsServices = require('./DnsServices');
						return DnsServices.deleteDns(fqdn, dnsFqdn);
					};

					const _updateEntityMeta = () => {

						Credential._updateDnsRecords(cred, dnsFqdn || fqdn);

						Credential.saveCredAction(cred, {
							action: Config.CredAction.DnsDeleted,
							fqdn:   fqdn || dnsFqdn,
							date:   Date.now()
						});

						return Promise.resolve(dnsFqdn || fqdn);
					};

					_deleteDns()
						.then(_updateEntityMeta)
						.then(resolve)
						.catch(reject)

				}).catch(reject);

			}
		);
	}

	async ensureDnsValue() {

		const resolveDns = (fqdn) => {
			const promise = util.promisify(dns.lookup)(fqdn).catch(reason => {
				debug_dns(`Failed to resolve ${fqdn} (${reason})`);
				throw reason;
			});
			return CommonUtils.withTimeout(promise, 3000, new Error('DNS resolution timed out'));
		};

		if (this.metadata.dnsRecords && this.metadata.dnsRecords.length) {
			// Make these different so if they are not resolved
			let expected_ip = {address: 'n/a-1'};
			let real_ip = {address: 'n/a-2'};
			try {
				debug_dns(`resolving expected=${this.metadata.dnsRecords[0].value} fqdn=${this.fqdn}`);
				[expected_ip, real_ip] = await Promise.all([
					resolveDns(this.metadata.dnsRecords[0].value),
					resolveDns(this.fqdn)
				]);
			} catch(e) {
				debug_dns('Failed to resolve');
			}
			if (expected_ip.address === real_ip.address) {
				debug_dns('DNS record is OK, not calling setDns');
				return this.metadata.dnsRecords[0].value;
			}
			debug_dns(`DNS records were expected_ip=${JSON.stringify(expected_ip)} real_ip=${JSON.stringify(real_ip)}`);
		} else {
			debug_dns(`There were no DNS records for ${this.fqdn} in metadata, will call setDns`);
		}

		return await this.setDns(this.fqdn, null, true);
	}

	static _updateDnsRecords(cred, dnsFqdn, dnsRecord) {

		const path = require('path');

		let meta = DirectoryServices.readJSON(path.join(cred.getMetadataKey("path"), Config.metadataFileName));

		if (!meta.dnsRecords) {
			meta.dnsRecords = [];
		}
		else {
			//delete old
			meta.dnsRecords.forEach(function (element, index) {
				if (element.fqdn == dnsFqdn) {
					meta.dnsRecords.splice(index, 1);
				}
			});
		}

		if (dnsRecord) {
			meta.dnsRecords.push(dnsRecord);
		}

		meta.dnsRecords.sort((a, b) => {
			try {
				let nameA = a.fqdn.toUpperCase(); // ignore upper and lowercase
				let nameB = b.fqdn.toUpperCase(); // ignore upper and lowercase
				if (nameA < nameB) {
					return -1;
				}
				if (nameA > nameB) {
					return 1;
				}

				// names must be equal
				return 0;
			} catch (e) {
				return 0;
			}
		});

		cred.beameStoreServices.writeMetadataSync(meta);
	}

//endregion

	//region common helpers
//noinspection JSUnusedGlobalSymbols
	/**
	 * @ignore
	 * @param {String} fqdn
	 * @returns {Promise}
	 */
	subscribeForChildRegistration(fqdn) {
		return new Promise((resolve, reject) => {
//noinspection JSDeprecatedSymbols
				let cred = this.store.getCredential(fqdn);

				if (!cred) {
					reject(`Creds for ${fqdn} not found`);
					return;
				}

				let apiData = ProvisionApi.getApiData(apiEntityActions.SubscribeRegistration.endpoint, {}),
				    api     = new ProvisionApi();

				api.setClientCerts(cred.getKey("PRIVATE_KEY"), cred.getKey("P7B"));

				//noinspection ES6ModulesDependencies,NodeModulesDependencies
				api.runRestfulAPI(apiData, (error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}
		);
	}

// Also used for SNIServer#addFqdn(fqdn, HERE, ...)
	/**
	 * @ignore
	 * @returns {{key: *, cert: *, ca: *}}
	 */
	getHttpsServerOptions() {
		let pk  = this.getKey("PRIVATE_KEY"),
		    p7b = this.getKey("P7B");
		//ca  = this.getKey("CA");

		if (!pk || !p7b) {
			throw new Error(`Credential#getHttpsServerOptions: fqdn ${this.fqdn} does not have required fields for running HTTPS server using this credential`);
		}
		return {
			key:  pk,
			cert: p7b
		};
	}

//endregion

	//region private helpers
	_selectEdge() {

		return new Promise((resolve, reject) => {
				beameUtils.selectBestProxy(Config.loadBalancerURL, 100, 1000, (error, payload) => {
					if (!error) {
						resolve(payload);
					}
					else {
						reject(error);
					}
				});
			}
		);
	}

	_syncMetadataOnCertReceived(fqdn) {
		return new Promise((resolve, reject) => {
				this.store.find(fqdn, false).then(cred => {
					if (cred == null) {
						reject(`credential for ${fqdn} not found`);
						return;
					}

					const retries = envProfile.RetryAttempts + 1,
					      sleep   = 1000;

					const _syncMeta = (retries, sleep) => {

						retries--;

						if (retries == 0) {
							reject(`Metadata of ${fqdn} can't be updated. Please try Later`);
							return;
						}

						cred.syncMetadata(fqdn).then(payload => {
							storeCacheServices.insertCredFromStore(cred, Config.OcspStatus.Good).then(() => {
								resolve(payload);
							});
						}).catch(() => {
							logger.debug(`retry on sync meta for ${fqdn}`);

							sleep = parseInt(sleep * (Math.random() + 1.5));

							setTimeout(() => {
								_syncMeta(retries, sleep);
							}, sleep);
						});
					};

					_syncMeta(retries, sleep);
				}).catch(reject);
			}
		);
	}

	_createInitialKeyPairs(dirPath) {
		let errMsg;

		return new Promise((resolve, reject) => {

				const _saveKeyPair = (private_key_name, public_key_name, cb) => {
					openSSlWrapper.createPrivateKey().then(pk =>
						DirectoryServices.saveFile(dirPath, private_key_name, pk, error => {
							if (!error) {
								let pkFile  = beameUtils.makePath(dirPath, private_key_name),
								    pubFile = beameUtils.makePath(dirPath, public_key_name);
								openSSlWrapper.savePublicKey(pkFile, pubFile).then(() => {
									cb(null);
								}).catch(error => {
									cb(error)
								});
							}
							else {
								errMsg = logger.formatErrorMessage("Failed to save Private Key", module_name, {"error": error}, Config.MessageCodes.OpenSSLError);
								cb(errMsg);
							}
						})
					).catch(error => {
						cb(error);
					})
				};

				//noinspection JSUnresolvedFunction
				async.parallel([
						cb => {
							_saveKeyPair(Config.CertFileNames.PRIVATE_KEY, Config.CertFileNames.PUBLIC_KEY, cb);
						},
						cb => {
							_saveKeyPair(Config.CertFileNames.BACKUP_PRIVATE_KEY, Config.CertFileNames.BACKUP_PUBLIC_KEY, cb);
						}
					],
					error => {
						if (error) {
							logger.error(`generating keys error ${BeameLogger.formatError(error)}`);
							reject(error);
						}

						resolve();
					})

			}
		);
	}

	_createTempKeys() {

		return new Promise((resolve, reject) => {

				openSSlWrapper.createPrivateKey().then(pk => {
						const NodeRSA   = require('node-rsa');
						let key         = new NodeRSA(pk),
						      publicDer = key.exportKey('pkcs8-public-der'),
						      publicPem = key.exportKey('pkcs8-public-pem'),
						      signature = key.sign(publicDer, 'base64', '');

						resolve({
							pubKeys: {
								pub: publicPem,
								signature,
							},
							pk
						});
					}
				).catch(error => {
					reject(error);
				})

			}
		);
	}

	/**
	 * @param payload
	 * @param metadata
	 * @param [validityPeriod]
	 * @param [password]
	 * @returns {Promise}
	 */
	_requestCerts(payload, metadata, validityPeriod, password) {
		return new Promise((resolve, reject) => {


				let sign = CommonUtils.parse(payload.sign);

				logger.debug("orderCerts()", payload);

				if (!sign) {
					reject('Invalid authorization token');
					return;
				}

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.GettingAuthCreds, payload.parent_fqdn);

				this.store.getNewCredentials(payload.fqdn, payload.parent_fqdn, sign).then(
					cred => {

						logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.AuthCredsReceived, payload.parent_fqdn);
						logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.GeneratingKeys, payload.fqdn);

						let dirPath = cred.getMetadataKey("path");

						cred._createInitialKeyPairs(dirPath).then(() => {
							logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.KeysCreated, payload.fqdn);

							OpenSSLWrapper.getPublicKeySignature(DirectoryServices.readFile(beameUtils.makePath(dirPath, Config.CertFileNames.PRIVATE_KEY))).then(signature => {

								let pubKeys = {
									pub:    DirectoryServices.readFile(beameUtils.makePath(dirPath, Config.CertFileNames.PUBLIC_KEY)),
									pub_bk: DirectoryServices.readFile(beameUtils.makePath(dirPath, Config.CertFileNames.BACKUP_PUBLIC_KEY)),
									signature
								};

								cred.getCert(sign, pubKeys, {validityPeriod, saveCerts: true, password}).then(() => {
									resolve(metadata);
								}).catch(onError);

							}).catch(onError);


						}).catch(onError);
					}).catch(onError);

				function onError(e) {
					logger.error(BeameLogger.formatError(e), e);
					reject(e);
				}
			}
		);
	}

	/**
	 * @param payload
	 * @param [validityPeriod]
	 * @param {String} password
	 * @returns {Promise}
	 */
	_requestVirtualCerts(payload, password, validityPeriod) {
		return new Promise((resolve, reject) => {

				let path = null;

				function deleteCredFolder() {
					const DirectoryServices = require('./DirectoryServices');
					if (path) {
						DirectoryServices.deleteFolder(path, nop);
					}
				}

				function onError(e) {
					logger.error(BeameLogger.formatError(e), e);
					deleteCredFolder();
					reject(e);
				}

				let sign = CommonUtils.parse(payload.sign),
				    fqdn = payload.fqdn;

				logger.debug("orderCerts()", payload);

				if (!sign) {
					reject('Invalid authorization token');
					return;
				}

				logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.GettingAuthCreds, payload.parent_fqdn);

				this.store.getNewCredentials(payload.fqdn, payload.parent_fqdn, sign).then(
					cred => {

						path = cred.getMetadataKey("path");
						deleteCredFolder();

						logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.AuthCredsReceived, payload.parent_fqdn);

						cred._createTempKeys().then(keys => {

							let private_key = keys.pk;

							cred.getCert(sign, keys.pubKeys, {validityPeriod, saveCerts: false}).then(payload => {

								if (!payload) {
									reject(`invalid cert request payload`);
									return;
								}

								const pem = require('pem');

								pem.createPkcs12(private_key, payload.p7b, password, [], (err, pfx) => {

									if (err) {
										reject(err);
										return;
									}

									resolve({
										fqdn,
										pfx: pfx.pkcs12
									});
								});

							}).catch(onError);
						}).catch(onError);
					}).catch(onError);
			}
		);
	}

	/**
	 *
	 * @param error
	 * @param payload
	 * @param {String|null} [password]
	 * @returns {Promise}
	 * @private
	 */
	_saveCerts(error, payload, password) {
		let fqdn = this.fqdn;

		return new Promise((resolve, reject) => {
				if (!error) {
					let dirPath           = this.getMetadataKey("path"),
					    directoryServices = this.store.directoryServices;

					logger.printStandardEvent(logger_entity, BeameLogger.StandardFlowEvent.ReceivedCerts, fqdn);

					directoryServices.saveCerts(dirPath, payload).then(() => {

						//noinspection JSUnresolvedFunction
						async.parallel(
							[
								function (callback) {

									openSSlWrapper.createPfxCert(dirPath, password).then(pwd => {
										directoryServices.saveFileAsync(beameUtils.makePath(dirPath, Config.CertFileNames.PWD), pwd, (error, data) => {
											if (!error) {
												callback(null, data)
											}
											else {
												callback(error, null)
											}
										})
									}).catch(function (error) {
										callback(error, null);
									});
								}
							],
							(error) => {
								if (error) {
									reject(error);
									return;
								}

								//reload credential
								this.initFromData(fqdn);

								resolve();
							}
						);
					}).catch(reject);
				}
				else {
					reject(error);
				}
			}
		);
	}

	static saveCredAction(cred, token) {
		cred.metadata = cred.beameStoreServices.readMetadataSync();

		if (!cred.metadata.actions) {
			cred.metadata.actions = [];
		}

		cred.metadata.actions.push(token);

		cred.beameStoreServices.writeMetadataSync(cred.metadata);
	}

//endregion

	//region Auth events
	saveAuthEvent(signerFqdn, payload){
		return new Promise((resolve, reject) => {
				this.store.find(signerFqdn).then(cred=>{
					const AuthToken = require('./AuthToken');
					let authToken = AuthToken.create(payload, cred);
					let api          = new ProvisionApi();

					let apiData  = ProvisionApi.getApiData(apiEntityActions.SaveAuthEvent.endpoint, {});

					api.runRestfulAPI(apiData, (error) => {
						error ? reject(error) : resolve();
					}, 'POST', authToken);

				}).then().catch(reject);
			}
		);
	}
	//endregion

	//endregion

	//region helpers
	static formatRegisterPostData(metadata) {
		return {
			name:          metadata.name,
			email:         metadata.email,
			parent_fqdn:   metadata.parent_fqdn,
			service_name:  metadata.serviceName,
			service_id:    metadata.serviceId,
			matching_fqdn: metadata.matchingFqdn,
			custom_fqdn:   metadata.custom_fqdn,
			src:           metadata.src
		};
	}

	checkValidity() {
		const check = () => {
			const validity = this.certData.validity;
			logger.debug(`checkValidity: fqdn, start, end', ${this.fqdn}, ${validity.start}, ${validity.end}`);
			// validity.end = 0;
			const now = Date.now();
			if (validity.start - Config.defaultAllowedClockDiff > now + timeFuzz) {
				throw new CertificateValidityError(`Certificate ${this.fqdn} is not valid yet`, CertValidationError.InFuture);
			}
			if (validity.end + Config.defaultAllowedClockDiff < now - timeFuzz) {
				throw new CertificateValidityError(`Certificate ${this.fqdn} has expired`, CertValidationError.Expired);
			}
			return this;
		}
		
		return this._initPromise.then(check);
	}

	hasLocalParentAtAnyLevel(fqdn) {

		if (this.fqdn == fqdn) {
			return true;
		}

		let parent_fqdn = this.getMetadataKey(Config.MetadataProperties.PARENT_FQDN);

		if (!parent_fqdn) {
			return false;
		}

		let parentCred = this.store.getCredential(parent_fqdn);

		if (!parentCred) {
			return false;
		}

		return parentCred.hasLocalParentAtAnyLevel(fqdn);
	}

	hasParent(parentFqdn) {


		let parent_fqdn = this.getMetadataKey(Config.MetadataProperties.PARENT_FQDN);

		if (!parent_fqdn) {
			return false;
		}

		return parent_fqdn === parentFqdn;
	}

	getParentsChain(credential, fqdn, parents = []) {

		if (!fqdn && !credential) return parents;

		let cred = credential || this.store.getCredential(fqdn);

		if (!cred) {
			return parents;
		}

		let parent_fqdn = cred.getMetadataKey(Config.MetadataProperties.PARENT_FQDN);

		if (!parent_fqdn) {
			return parents;
		}

		let parent = this.store.getCredential(parent_fqdn);

		if (!parent) {
			return parents;
		}

		let hasLevel = parent.hasMetadataKey(Config.MetadataProperties.LEVEL),
		    lvl      = hasLevel ? parent.getMetadataKey(Config.MetadataProperties.LEVEL) : null;

		parents.push({
			fqdn:          parent_fqdn,
			name:          parent.getMetadataKey(Config.MetadataProperties.NAME),
			hasPrivateKey: parent.hasKey("PRIVATE_KEY"),
			level:         hasLevel ? parseInt(lvl) : null,
			expired:       parent.expired
		});

		return this.getParentsChain(parent, parent_fqdn, parents);
	}

	//endregion

	//region live credential
	/**
	 * Import remote(non-Beame) credentials and save it to store(x509 + metadata)
	 * @public
	 * @method  Credential.importLiveCredentials
	 * @param {String} fqdn
	 */
	static importLiveCredentials(fqdn) {
		if (!fqdn) {
			throw new Error('importLiveCredentials: fqdn is a required argument');
		}
		const store = new (require("./BeameStoreV2"))();
		let tls     = require('tls');
		try {
			let ciphers           = tls.getCiphers().filter(cipher => {
				return cipher.indexOf('ec') < 0;

			});
			let allowedCiphers    = ciphers.join(':').toUpperCase();
			let conn              = tls.connect(443, fqdn, {host: fqdn, ciphers: allowedCiphers});
			let onSecureConnected = function () {
				//noinspection JSUnresolvedFunction
				let cert = conn.getPeerCertificate(true);
				conn.end();
				let bas64Str              = new Buffer(cert.raw, "hex").toString("base64");
				let certBody              = "-----BEGIN CERTIFICATE-----\r\n";
				certBody += bas64Str.match(/.{1,64}/g).join("\r\n") + "\r\n";
				certBody += "-----END CERTIFICATE-----";
				let credentials           = store.addToStore(certBody);
				credentials.metadata.live = true;
				credentials.saveCredentialsObject();
			};

			conn.on('error', function (error) {
				let msg = error && error.message || error.toString();
				logger.fatal(msg);
			});

			conn.once('secureConnect', onSecureConnected);

		}
		catch (e) {
			logger.fatal(e.toString());
		}

	}

	async isRevoked(forceCheck=false) {
		const status = await this.checkOcspStatus(this, forceCheck);
		return status === Config.OcspStatus.Bad;
	}

//endregion
}

Credential.CertificateValidityError = CertificateValidityError;

module.exports = Credential;
