import * as schema from '../schema/index'
import { XmlHelper } from "../xmlHelper";
import { WebServiceHelper, WebProxy } from "../webservices/webserviceHelper";
import { Empresa, ServicosSefaz, Configuracoes, RetornoProcessamento } from "../interface/nfe";
import * as Utils from "../utils/utils";
import { SefazNFCe } from "../webservices/sefazNfce";
import { SefazNFe } from "../webservices/sefazNfe";
import { Evento, DetalheEvento } from '../interface';
import { Signature } from '../signature';
import * as fs from 'fs';
import * as path from 'path';

let soapEvento: any = null;

/**
 * Classe para processamento de Eventos ( Cancelamento / Inutilização )
 */
export class EventoProcessor {

    constructor(
        private configuracoes: Configuracoes
    ) {
        if (!this.configuracoes.geral.versao) this.configuracoes.geral.versao = '4.00';
        if (!this.configuracoes.webservices) this.configuracoes.webservices = { tentativas: 3, aguardarConsultaRetorno: 1000 };
        if (!this.configuracoes.webservices.tentativas) this.configuracoes.webservices.tentativas = 3;
        if (!this.configuracoes.webservices.aguardarConsultaRetorno) this.configuracoes.webservices.aguardarConsultaRetorno = 1000;
        if (this.configuracoes.arquivos) {
            if (this.configuracoes.arquivos.pastaEnvio && (!'/\\'.includes(this.configuracoes.arquivos.pastaEnvio.substr(-1))))
                this.configuracoes.arquivos.pastaEnvio = this.configuracoes.arquivos.pastaEnvio + path.sep;
            if (this.configuracoes.arquivos.pastaRetorno && (!'/\\'.includes(this.configuracoes.arquivos.pastaRetorno.substr(-1))))
                this.configuracoes.arquivos.pastaRetorno = this.configuracoes.arquivos.pastaRetorno + path.sep;
            if (this.configuracoes.arquivos.pastaXML && (!'/\\'.includes(this.configuracoes.arquivos.pastaXML.substr(-1))))
                this.configuracoes.arquivos.pastaXML = this.configuracoes.arquivos.pastaXML + path.sep;
        }
    }

    public async executar(evento: Evento) {
        let result = <RetornoProcessamento>{
            success: false
        };

        evento.detEvento = evento.detEvento || <DetalheEvento>{};

        switch (evento.tpEvento) {
            case '110111':
                evento.detEvento.descEvento = 'Cancelamento';
                break;
            case '110110':
                evento.detEvento.descEvento = 'Carta de Correcao';
                evento.detEvento.xCondUso = `A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.`;
                break
            case '210200':
                evento.detEvento.descEvento = 'Confirmacao da Operacao';
                break
            case '210210':
                evento.detEvento.descEvento = 'Ciencia da Operacao';
                break
            case '210220':
                evento.detEvento.descEvento = 'Desconhecimento da Operacao';
                break
            case '210240':
                evento.detEvento.descEvento = 'Operacao nao Realizada';
                break
            case '110140':
                evento.detEvento.descEvento = 'EPEC';
                break
        }

        try {
            const { geral: { ambiente }, empresa, arquivos } = this.configuracoes
            const Sefaz = this.getSefazCliente(evento.tpEvento);
            const autorizador = this.getAutorizadorEvento(evento.tpEvento, empresa.endereco.uf);

            soapEvento = Sefaz.getSoapInfo(autorizador, ambiente, ServicosSefaz.evento);

            const xml = this.gerarXml(evento);
            const xmlAssinado = Signature.signXmlX509(xml, 'infEvento', this.configuracoes.certificado);

            let xmlLote = this.gerarXmlLote(xmlAssinado);

            result = await this.transmitirXml(xmlLote, autorizador, evento.tpEvento);

            if (arquivos.salvar) {
                if (! await fs.existsSync(arquivos.pastaEnvio)) await fs.mkdirSync(arquivos.pastaEnvio, { recursive: true });
                if (! await fs.existsSync(arquivos.pastaRetorno)) await fs.mkdirSync(arquivos.pastaRetorno, { recursive: true });
                if (!await fs.existsSync(arquivos.pastaXML)) await fs.mkdirSync(arquivos.pastaXML, { recursive: true });

                const cStat = Object(result.data).retEnvEvento.retEvento.infEvento.cStat;
                if ((result.success == true) && (cStat == 135 || cStat == 136 || cStat == '135' || cStat == '136')) {
                    const filename = `${arquivos.pastaXML}${evento.chNFe}${evento.tpEvento}-procEventoNFe.xml`;

                    const procEvento = <schema.TProcEvento>{
                        $: { versao: "1.00", xmlns: "http://www.portalfiscal.inf.br/nfe" },
                        _: '[XML_EVENTO]',
                        retEvento: Object(result.data).retEnvEvento.retEvento
                    };

                    Utils.removeSelfClosedFields(procEvento);
                    let xmlProcEvento = XmlHelper.serializeXml(procEvento, 'procEvento');
                    xmlProcEvento = xmlProcEvento.replace('[XML_EVENTO]', xmlAssinado);

                    await fs.writeFileSync(filename, xmlProcEvento);
                } else {
                    const filenameEnvio = `${arquivos.pastaEnvio}${evento.chNFe}${evento.tpEvento}-envEventoCancNFe.xml`;
                    const filenameRetorno = `${arquivos.pastaRetorno}${evento.chNFe}${evento.tpEvento}-retEnvEventoCancNFe.xml`;

                    await fs.writeFileSync(filenameEnvio, result.xml_enviado);
                    await fs.writeFileSync(filenameRetorno, result.xml_recebido);
                }
            }
        } catch (ex) {
            result.success = false;
            result.error = ex;
        }

        return result;
    }

    private isManifestacaoDestinatario(tpEvento: string) {
        return ['210200', '210210', '210220', '210240'].includes(tpEvento);
    }

    private getAutorizadorEvento(tpEvento: string, uf: string) {
        return this.isManifestacaoDestinatario(tpEvento) ? 'SVAN' : uf;
    }

    private getSefazCliente(tpEvento: string) {
        if (this.isManifestacaoDestinatario(tpEvento)) return SefazNFe;
        return this.configuracoes.geral.modelo == '65' ? SefazNFCe : SefazNFe;
    }

    private async transmitirXml(xml: string, autorizador: string, tpEvento: string) {
        const { geral: { ambiente }, certificado, webProxy } = this.configuracoes;

        const Sefaz = this.getSefazCliente(tpEvento);
        const soap = Sefaz.getSoapInfo(autorizador, ambiente, ServicosSefaz.evento);
        return await WebServiceHelper.makeSoapRequest(xml, certificado, soap, webProxy);
    }

    private getInfEvento(evento: Evento) {
        const { geral: { ambiente }, empresa } = this.configuracoes;
        const _ID = `ID${evento.tpEvento}${evento.chNFe}${("00" + evento.nSeqEvento).slice(-2)}`;
        if (_ID.length < 54) throw 'ID de Evento inválido';

        return <schema.TEventoInfEvento>{
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

    private getDetEvento(evento: Evento) {
        //TODO: transformar tpEvento em enum
        const result = <schema.TEventoInfEventoDetEvento>{
            $: { versao: '1.00' },
            descEvento: evento.detEvento.descEvento,
        };
        if (evento.tpEvento == '110110') {
            result.xCorrecao = evento.detEvento.xCorrecao;
            result.xCondUso = evento.detEvento.xCondUso;
        };
        if (evento.tpEvento == '110111') { //cancelamento
            result.nProt = evento.detEvento.nProt;
            result.xJust = evento.detEvento.xJust;
        };
        if (evento.tpEvento == 'cancSubst') {
            result.cOrgaoAutor = evento.detEvento.cOrgaoAutor;
            result.tpAutor = '001';
            result.verAplic = evento.detEvento.verAplic;
            result.nProt = evento.detEvento.nProt;
            result.xJust = evento.detEvento.xJust;
            result.chNFeRef = evento.detEvento.chNFeRef;
        };
        if (evento.tpEvento == '210240') {
            result.xJust = evento.detEvento.xJust;
        };

        return result;
    }

    private gerarXml(evento: Evento) {
        const xmlEvento = <schema.TEvento>{
            $: {
                versao: '1.00',
                xmlns: 'http://www.portalfiscal.inf.br/nfe'
            },
            infEvento: this.getInfEvento(evento)
        };

        Utils.removeSelfClosedFields(xmlEvento);
        return XmlHelper.serializeXml(xmlEvento, 'evento');
    }

    private gerarXmlLote(xml: string) {
        //TODO: ajustar para receber uma lista de xmls...
        const { geral: { versao } } = this.configuracoes;

        const loteId = Utils.randomInt(1, 999999999999999).toString();
        const envEvento = <schema.TEnviEvento>{
            $: { versao: '1.00', xmlns: 'http://www.portalfiscal.inf.br/nfe' },
            idLote: loteId,
            _: '[XMLS]'
        };

        const xmlLote = XmlHelper.serializeXml(envEvento, 'envEvento');
        return xmlLote.replace('[XMLS]', xml);
    }

}