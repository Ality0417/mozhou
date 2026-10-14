// 原创离线样本，固定文本不是模型输出，也不是文学质量证明。
export const writingFixtures = [
  {
    id: 'fantasy-adventure', language: 'en' as const, genre: 'Fantasy adventure', title: 'The Borrowed Tide',
    inspiration: 'A mapmaker finds a tide trapped inside a brass compass.', chapterTitle: 'A Debt Beneath the Bridge',
    content: `Mara knew the bridge was listening because its nails turned toward her voice.

She kept the brass compass under her coat. Every minute it grew colder, and every minute the river below rose another finger's width. The ferryman had warned her not to bring a borrowed tide home. He had not mentioned that the tide could recognize her.

"One crossing," she told the bridge. "That was our agreement."

The oldest plank lifted. Beneath it lay a child's shoe, perfectly dry. Mara recognized the blue ribbon tied through its buckle. Her brother had worn that ribbon on the morning the river took him.

She stepped back instead of reaching for it. The bridge offered memories, not evidence. Its first bargain had taught her that distinction at the cost of three years of sleep.

Across the water, a lantern flashed twice. Tomas was still waiting at the mill, exactly where the real map said he would be. Mara loosened the compass lid and listened for the little wave inside. If she released it now, the bridge would lose its voice. The mill would also flood.

She pulled a blank page from her case and drew a third bank beside the river. The ink stayed wet. Then a pale strip of shore appeared beneath the bridge, narrow as a promise. Somewhere downstream, someone began to applaud.`
  },
  {
    id: 'urban-mystery', language: 'zh-CN' as const, genre: '都市悬疑', title: '最后一班电梯',
    inspiration: '夜班维修工发现同一台电梯每天多停一个不存在的楼层。', chapterTitle: '三点十七分',
    content: `凌晨三点十七分，电梯停在了十三楼。林禾盯着检修屏，上面的楼层编号却仍然是十二。

她没有开门。昨晚的监控里，保安也是先听到敲击声，才按下开门键的。之后七分钟的画面被白色噪点覆盖，而保安说自己只在楼道里站了几秒。

门外传来两下敲击，一长一短。林禾把对讲机贴近嘴边，问值班室能否看见她。回应的不是人声，而是纸张翻动的声音。

她从工具包里取出胶带，将检修屏的变化逐秒记在手套上。三点十八分，门外有人叫了她的名字。那声音很像父亲，但父亲从不叫她全名。

林禾关闭扬声器，按下返回键。电梯没有移动，屏幕却出现一行新的维修记录：林禾，已到场。

记录的提交时间，是明天。`
  }
]
