<template>
  <div class="grid min-h-dvh lg:grid-cols-[5fr_7fr]">
    <section class="flex flex-col justify-between bg-black px-6 py-10 text-white sm:px-12 lg:px-16">
      <p class="text-xl font-bold tracking-[-0.04em]">NEXORA<span class="text-[#e0524f]">.</span></p>
      <div class="my-16 max-w-[16ch]">
        <h1 class="text-[clamp(2.5rem,4.5vw,4.25rem)] font-bold leading-[0.98] tracking-[-0.045em]">
          Cada cifra, verificable<span class="text-[#e0524f]" aria-hidden="true">.</span>
        </h1>
      </div>
      <p class="max-w-[46ch] text-sm leading-relaxed text-[#b9b8bb]">
        Consolidación automática de presupuestos multiempresa y multimoneda, con trazabilidad hasta el archivo original
        y dashboards creados mediante inteligencia artificial.
      </p>
    </section>
    <section class="flex items-center justify-center px-6 py-12 sm:px-12">
      <div class="w-full max-w-sm"><slot /></div>
    </section>
  </div>
</template>
