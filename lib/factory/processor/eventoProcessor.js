"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventoProcessor = void 0;
const schema = require("../schema/index");
const xmlHelper_1 = require("../xmlHelper");
const webserviceHelper_1 = require("../webservices/webserviceHelper");
const nfe_1 = require("../interface/nfe");
const Utils = require("../utils/utils");
const sefazNfce_1 = require("../webservices/sefazNfce");
const sefazNfe_1 = require("../webservices/sefazNfe");
const signature_1 = require("../signature");
const fs = require("fs");
const path = require("path");
let soapEvento = null;
/**
 * Classe para processamento de Eventos ( Cancelamento / Inutilização )
 */
class EventoProcessor {
    constructor(configuracoes) {
        this.configuracoes = configuracoes;
        if (!this.configuracoes.geral.versao)
            this.configuracoes.geral.versao = '4.00';
        if (!this.configuracoes.webservices)
            this.configuracoes.webservices = { tentativas: 3, aguardarConsultaRetorno: 1000 };
        if (!this.configuracoes.webservices.tentativas)
            this.configuracoes.webservices.tentativas = 3;
        if (!this.configuracoes.webservices.aguardarConsultaRetorno)
            this.configuracoes.webservices.aguardarConsultaRetorno = 1000;
        if (this.configuracoes.arquivos) {
            if (this.configuracoes.arquivos.pastaEnvio && (!'/\\'.includes(this.configuracoes.arquivos.pastaEnvio.substr(-1))))
                this.configuracoes.arquivos.pastaEnvio = this.configuracoes.arquivos.pastaEnvio + path.sep;
            if (this.configuracoes.arquivos.pastaRetorno && (!'/\\'.includes(this.configuracoes.arquivos.pastaRetorno.substr(-1))))
                this.configuracoes.arquivos.pastaRetorno = this.configuracoes.arquivos.pastaRetorno + path.sep;
            if (this.configuracoes.arquivos.pastaXML && (!'/\\'.includes(this.configuracoes.arquivos.pastaXML.substr(-1))))
                this.configuracoes.arquivos.pastaXML = this.configuracoes.arquivos.pastaXML + path.sep;
        }
    }
    async executar(evento) {
        let result = {
            success: false
        };
        evento.detEvento = evento.detEvento || {};
        switch (evento.tpEvento) {
            case '110111':
                evento.detEvento.descEvento = 'Cancelamento';
                break;
            case '110110':
                evento.detEvento.descEvento = 'Carta de Correcao';
                evento.detEvento.xCondUso = `A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.`;
                break;
            case '210200':
                evento.detEvento.descEvento = 'Confirmacao da Operacao';
                break;
            case '210210':
                evento.detEvento.descEvento = 'Ciencia da Operacao';
                break;
            case '210220':
                evento.detEvento.descEvento = 'Desconhecimento da Operacao';
                break;
            case '210240':
                evento.detEvento.descEvento = 'Operacao nao Realizada';
                break;
            case '110140':
                evento.detEvento.descEvento = 'EPEC';
                break;
        }
        try {
            const { geral: { ambiente }, empresa, arquivos } = this.configuracoes;
            const Sefaz = this.getSefazCliente(evento.tpEvento);
            const autorizador = this.getAutorizadorEvento(evento.tpEvento, empresa.endereco.uf);
            soapEvento = Sefaz.getSoapInfo(autorizador, ambiente, nfe_1.ServicosSefaz.evento);
            const xml = this.gerarXml(evento);
            const xmlAssinado = signature_1.Signature.signXmlX509(xml, 'infEvento', this.configuracoes.certificado);
            let xmlLote = this.gerarXmlLote(xmlAssinado);
            result = await this.transmitirXml(xmlLote, autorizador, evento.tpEvento);
            if (arquivos.salvar) {
                if (!await fs.existsSync(arquivos.pastaEnvio))
                    await fs.mkdirSync(arquivos.pastaEnvio, { recursive: true });
                if (!await fs.existsSync(arquivos.pastaRetorno))
                    await fs.mkdirSync(arquivos.pastaRetorno, { recursive: true });
                if (!await fs.existsSync(arquivos.pastaXML))
                    await fs.mkdirSync(arquivos.pastaXML, { recursive: true });
                const cStat = Object(result.data).retEnvEvento.retEvento.infEvento.cStat;
                if ((result.success == true) && (cStat == 135 || cStat == 136 || cStat == '135' || cStat == '136')) {
                    const filename = `${arquivos.pastaXML}${evento.chNFe}${evento.tpEvento}-procEventoNFe.xml`;
                    const procEvento = {
                        $: { versao: "1.00", xmlns: "http://www.portalfiscal.inf.br/nfe" },
                        _: '[XML_EVENTO]',
                        retEvento: Object(result.data).retEnvEvento.retEvento
                    };
                    Utils.removeSelfClosedFields(procEvento);
                    let xmlProcEvento = xmlHelper_1.XmlHelper.serializeXml(procEvento, 'procEvento');
                    xmlProcEvento = xmlProcEvento.replace('[XML_EVENTO]', xmlAssinado);
                    await fs.writeFileSync(filename, xmlProcEvento);
                }
                else {
                    const filenameEnvio = `${arquivos.pastaEnvio}${evento.chNFe}${evento.tpEvento}-envEventoCancNFe.xml`;
                    const filenameRetorno = `${arquivos.pastaRetorno}${evento.chNFe}${evento.tpEvento}-retEnvEventoCancNFe.xml`;
                    await fs.writeFileSync(filenameEnvio, result.xml_enviado);
                    await fs.writeFileSync(filenameRetorno, result.xml_recebido);
                }
            }
        }
        catch (ex) {
            result.success = false;
            result.error = ex;
        }
        return result;
    }
    isManifestacaoDestinatario(tpEvento) {
        return ['210200', '210210', '210220', '210240'].includes(tpEvento);
    }
    getAutorizadorEvento(tpEvento, uf) {
        return this.isManifestacaoDestinatario(tpEvento) ? 'SVAN' : uf;
    }
    getSefazCliente(tpEvento) {
        if (this.isManifestacaoDestinatario(tpEvento))
            return sefazNfe_1.SefazNFe;
        return this.configuracoes.geral.modelo == '65' ? sefazNfce_1.SefazNFCe : sefazNfe_1.SefazNFe;
    }
    async transmitirXml(xml, autorizador, tpEvento) {
        const { geral: { ambiente }, certificado, webProxy } = this.configuracoes;
        const Sefaz = this.getSefazCliente(tpEvento);
        const soap = Sefaz.getSoapInfo(autorizador, ambiente, nfe_1.ServicosSefaz.evento);
        return await webserviceHelper_1.WebServiceHelper.makeSoapRequest(xml, certificado, soap, webProxy);
    }
    getInfEvento(evento) {
        const { geral: { ambiente }, empresa } = this.configuracoes;
        const _ID = `ID${evento.tpEvento}${evento.chNFe}${("00" + evento.nSeqEvento).slice(-2)}`;
        if (_ID.length < 54)
            throw 'ID de Evento inválido';
        return {
            $: { Id: _ID },
            cOrgao: this.isManifestacaoDestinatario(evento.tpEvento) ? schema.TCOrgaoIBGE.Item91 : empresa.endereco.cUf,
            tpAmb: Utils.getEnumByValue(schema.TAmb, ambiente),
            CNPJ: empresa.cnpj,
            chNFe: evento.chNFe,
            dhEvento: evento.dhEvento,
            tpEvento: evento.tpEvento,
            nSeqEvento: evento.nSeqEvento,
            verEvento: '1.00',
            detEvento: this.getDetEvento(evento)
        };
    }
    getDetEvento(evento) {
        //TODO: transformar tpEvento em enum
        const result = {
            $: { versao: '1.00' },
            descEvento: evento.detEvento.descEvento,
        };
        if (evento.tpEvento == '110110') {
            result.xCorrecao = evento.detEvento.xCorrecao;
            result.xCondUso = evento.detEvento.xCondUso;
        }
        ;
        if (evento.tpEvento == '110111') { //cancelamento
            result.nProt = evento.detEvento.nProt;
            result.xJust = evento.detEvento.xJust;
        }
        ;
        if (evento.tpEvento == 'cancSubst') {
            result.cOrgaoAutor = evento.detEvento.cOrgaoAutor;
            result.tpAutor = '001';
            result.verAplic = evento.detEvento.verAplic;
            result.nProt = evento.detEvento.nProt;
            result.xJust = evento.detEvento.xJust;
            result.chNFeRef = evento.detEvento.chNFeRef;
        }
        ;
        if (evento.tpEvento == '210240') {
            result.xJust = evento.detEvento.xJust;
        }
        ;
        return result;
    }
    gerarXml(evento) {
        const xmlEvento = {
            $: {
                versao: '1.00',
                xmlns: 'http://www.portalfiscal.inf.br/nfe'
            },
            infEvento: this.getInfEvento(evento)
        };
        Utils.removeSelfClosedFields(xmlEvento);
        return xmlHelper_1.XmlHelper.serializeXml(xmlEvento, 'evento');
    }
    gerarXmlLote(xml) {
        //TODO: ajustar para receber uma lista de xmls...
        const { geral: { versao } } = this.configuracoes;
        const loteId = Utils.randomInt(1, 999999999999999).toString();
        const envEvento = {
            $: { versao: '1.00', xmlns: 'http://www.portalfiscal.inf.br/nfe' },
            idLote: loteId,
            _: '[XMLS]'
        };
        const xmlLote = xmlHelper_1.XmlHelper.serializeXml(envEvento, 'envEvento');
        return xmlLote.replace('[XMLS]', xml);
    }
}
exports.EventoProcessor = EventoProcessor;
