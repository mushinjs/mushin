export default function registerStartCommand(cli: any) {
  cli.command('start', 'Start the development server').action(() => {
    console.log('start')
  })
}
