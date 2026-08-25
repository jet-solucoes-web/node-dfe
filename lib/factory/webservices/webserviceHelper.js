"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebServiceHelper = void 0;
const request = require("request");
const xmlHelper_1 = require("../xmlHelper");
function proxyToUrl(pr) {
    const server = `${pr.host}:${pr.port}`;
    let auth = null;
    let final = pr.isHttps ? 'https://' : 'http://';
    if (pr.auth) {
        final = `${final}${pr.auth.username}:${pr.auth.password}@`;
    }
    return `${final}${server}`;
}
class WebServiceHelper {
    static httpPost(reqOpt) {
        return new Promise((resolve, reject) => {
            console.log(reqOpt);
            request.post(reqOpt, function (err, resp, body) {
                console.error(err);
                if (err) {
                    reject(err);
                }
                resolve({
                    response: resp,
                    body: body
                });
            });
        });
    }
    static buildSoapEnvelope(xml, soapMethod, raw) {
        let soapEnvelopeObj = {
            '$': { 'xmlns:soap12': 'http://www.w3.org/2003/05/soap-envelope',
                'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
                'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema' },
            'soap12:Body': {
                'nfeDadosMsg': {
                    '$': {
                        'xmlns': soapMethod
                    },
                    _: '[XML]'
                }
            }
        };
        let soapEnvelopeObjRaw = {
            '$': {
                'xmlns:soap12': 'http://www.w3.org/2003/05/soap-envelope',
                'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
                'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema'
            },
            'soap12:Body': {
                _: '[XML]'
            }
        };
        let soapEnvXml = xmlHelper_1.XmlHelper.serializeXml(raw ? soapEnvelopeObjRaw : soapEnvelopeObj, 'soap12:Envelope');
        return soapEnvXml.replace('[XML]', xml);
    }
    /*
    public static getHttpsAgent(cert: any) {
        return new https.Agent({
            rejectUnauthorized: false,
            //strictSSL: false,
            pfx: cert.pfx,
            passphrase: cert.password
        });
    }
    */
    static buildSoapRequestOpt(cert, soapParams, xml, proxy, raw) {
        const result = {
            url: soapParams.url,
            agentOptions: this.buildCertAgentOpt(cert),
            headers: {
                "Content-Type": soapParams.action
                    ? `${soapParams.contentType};action="${soapParams.action}"`
                    : soapParams.contentType
            },
            body: this.buildSoapEnvelope(xml, soapParams.method, raw),
            family: 4 //workaround para erro de dns em versões antigas da glibc
        };
        if (proxy) {
            result.proxy = proxyToUrl(proxy);
        }
        console.log(result);
        return result;
    }
    static buildCertAgentOpt(cert) {
        const certAgentOpt = {};
        if (cert.opcoes && cert.opcoes.stringfyPassphrase) {
            certAgentOpt.passphrase = cert.password.toString();
        }
        else
            (certAgentOpt.passphrase = cert.password);
        if (!cert.opcoes || (cert.opcoes && !cert.opcoes.removeRejectUnauthorized)) {
            certAgentOpt.rejectUnauthorized = (cert.rejectUnauthorized === undefined) ? true : cert.rejectUnauthorized;
        }
        if (cert.pfx) {
            certAgentOpt.pfx = cert.pfx;
        }
        if (cert.pem) {
            certAgentOpt.cert = cert.pem;
        }
        if (cert.key) {
            certAgentOpt.key = cert.key;
        }
        return certAgentOpt;
    }
    static async makeSoapRequest(xml, cert, soap, proxy, raw) {
        let result = { xml_enviado: xml };
        try {
            const reqOpt = this.buildSoapRequestOpt(cert, soap, xml, proxy, raw);
            console.log('----->', reqOpt.url);
            //let res = await axios(reqOpt);
            const res = (await this.httpPost(reqOpt));
            console.log('----->', res.response.statusCode);
            result.status = res.response.statusCode;
            result.xml_recebido = res.response.body;
            if (result.status == 200) {
                result.success = true;
                //let retorno = (require('util').inspect(XmlHelper.deserializeXml(res.data), false, null));
                let retorno = xmlHelper_1.XmlHelper.deserializeXml(result.xml_recebido, { explicitArray: false });
                console.log('retorno:', JSON.stringify(retorno));
                if (retorno) {
                    if (Object(retorno)['soap:Envelope'] && Object(retorno)['soap:Envelope']['soap:Body'] && Object(retorno)['soap:Envelope']['soap:Body']['nfeDistDFeInteresseResponse']) {
                        result.data = Object(retorno)['soap:Envelope']['soap:Body']['nfeDistDFeInteresseResponse']['nfeDistDFeInteresseResult'];
                    }
                    else if (Object(retorno)['soap:Envelope'] && Object(retorno)['soap:Envelope']['soap:Body'] && Object(retorno)['soap:Envelope']['soap:Body']['nfeRecepcaoEventoNFResult']) {
                        result.data = Object(retorno)['soap:Envelope']['soap:Body']['nfeRecepcaoEventoNFResult'];
                    }
                    else if (Object(retorno)['S:Envelope'] && Object(retorno)['S:Envelope']['S:Body'] && Object(retorno)['S:Envelope']['S:Body']['ns2:nfeResultMsg']) {
                        result.data = Object(retorno)['S:Envelope']['S:Body']['ns2:nfeResultMsg'];
                    }
                    else {
                        //result.data = retorno;
                        result.data = Object(retorno)['S:Envelope'] != undefined ? result.data = Object(retorno)['S:Envelope']['S:Body']['nfeResultMsg'] : result.data = Object(retorno)['env:Envelope']['env:Body']['nfeResultMsg'];
                        //console.log(result.data)
                    }
                }
            }
            console.log('----->', result.success);
            return result;
        }
        catch (err) {
            result.success = false;
            result.error = err;
            console.log('----->', result.success);
            return result;
        }
    }
}
exports.WebServiceHelper = WebServiceHelper;
