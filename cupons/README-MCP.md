# LIA — MCP de Cupons

## Arquivos do GitHub Pages

Envie a pasta `oauth` para a raiz do repositório `cupons`, preservando esta estrutura:

```text
cupons/
├── index.html
├── admin.html
└── oauth/
    └── consent/
        └── index.html
```

A página de autorização ficará disponível em:

`https://gpttecnologic-dot.github.io/cupons/oauth/consent`

## MCP personalizado no ChatGPT

Nome sugerido: `LIA Cupons`

URL do servidor MCP:

`https://eunnrjqeuczhtghbbzos.supabase.co/functions/v1/cupom-mcp`

Autenticação: `OAuth`

Ferramentas expostas:

- `consultar_quantidade_cupons`
- `listar_cupons_disponiveis`
- `reservar_cupom` — alteração sujeita a confirmação
- `devolver_cupom` — alteração sujeita a confirmação

## Segurança

- O servidor valida o token OAuth em cada requisição.
- Nenhuma chave `service_role` é usada ou enviada ao ChatGPT.
- Reservas só afetam cupons `available`, sem usuário e não ativados.
- Devoluções só afetam cupons `reserved` e não ativados.
- Alterações são registradas na tabela `events`.
